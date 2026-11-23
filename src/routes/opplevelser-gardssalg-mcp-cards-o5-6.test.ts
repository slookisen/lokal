/**
 * opplevelser-gardssalg-mcp-cards-o5-6.test.ts — dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter, slice O5-6
 * («kort i samtalen»).
 *
 * Two cards behind GARDSSALG_MCP_CARDS_ENABLED (off): the producer list for
 * discover_gardssalg and the booking summary for book_gardssalg /
 * get_gardssalg_booking, as `ui://` resources with `structuredContent`.
 *
 *   (ak1) flag off: tools/list, resources/list and the discover_gardssalg /
 *         book_gardssalg / preview / get_gardssalg_booking results equal the
 *         goldens taken on main db7d8df before this slice, both with every
 *         other O5 flag off and with them on. No structuredContent.
 *   (ak2) flag on: resources/list has the two card resources; tools/list
 *         changes only by `_meta` on the gardssalg tools; discover_gardssalg,
 *         book_gardssalg (send, preview, duplicate) and get_gardssalg_booking
 *         against the test producer carry structuredContent that validates
 *         against the card schema; the text content stays byte-identical.
 *   (ak3) no image element, no product name from the test list and never the
 *         word «tasting» in the card HTML or the card data (with negative
 *         controls showing the check catches each).
 *   (ak4) CSP metadata: no foreign domains, no `ui.domain` (Claude), the HTML
 *         loads nothing from the network.
 *   (txt) card texts verbatim from text package OA-2 §D.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-mcp-cards-o5-6.test.ts
 *   (--print prints the flag-off hashes used as goldens below)
 * Wired into the gate via tests/test.ts.
 */

import express from "express";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Goldens: sha256 of the JSON-RPC `result` objects for the fixtures below,
// computed on lokal main db7d8df (before O5-6) with --print. Dynamic values
// (booking_ref, guest_ref, status link, times) are replaced by placeholders
// before hashing; see normalise().
const GOLDEN = {
  off: {
    "tools/list": "ca0b5c861ae68df2121db9fa96187301f5c5884546f6db579f0231d97b7544c3",
    "resources/list": "8599eaf7ef5f585ed3ac456f014a5a73359507078927969aa35f4c3e4fa972a2",
    discover: "c8f1d6760d64df400bf6f7a9b35d0748af932554aa401ddcd0d7534c4ab750d6",
    book: "e8eef3abaf535007c434a86dafd3e3e6733aad2995b8cb628f78bb4c93dee7ab",
  },
  others_on: {
    "tools/list": "3978a42bd39504fb7446e5c0a93a7ed30d118acba404aece6e097ba3bf1d1b18",
    "resources/list": "8599eaf7ef5f585ed3ac456f014a5a73359507078927969aa35f4c3e4fa972a2",
    discover: "da7ebdda2839d4d4f4d383128152b105de81bb8a4ddab4b7eaf5672a342031cb",
    book: "75102e18943b209b67ef1ef7725cac5e356485b4b839754a929bf30cf7373119",
    preview: "ef83ed7e4e79036c96b0accdf8daedd81bf4af915eb584284509d91542f821f4",
    status: "51693b6fd3ca987f40b3bba7ca1702da7d9487bfb939c654d924963d7ae540e2",
  },
} as const;

const TEST_PROVIDER_ID = "0d11485a-c774-4f75-8bca-fd6e6fe19f8c";
// AK3 test list: product names a producer row carries in its own data.
const PRODUCT_NAMES = ["Ktfjordbris", "Gamle Ktvik", "Ktgull Eplemost"];
const OTHER_O5_FLAGS = [
  "GARDSSALG_MCP_GUEST_REF_ENABLED",
  "GARDSSALG_MCP_PREVIEW_ENABLED",
  "GARDSSALG_MCP_STATUS_TOOL_ENABLED",
  "GARDSSALG_MCP_VISIT_FACTS_ENABLED",
];

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line in response body");
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
function futureSlot(daysAhead: number, hour = 11): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string): number => +(parts.find((p) => p.type === t)?.value ?? "0");
  const b = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + daysAhead));
  return `${b.getUTCFullYear()}-${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())}T${pad2(hour)}:00`;
}

const CHATGPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

const ownerLocks = (...fields: string[]): string =>
  JSON.stringify({ owner_locks: Object.fromEntries(fields.map((f) => [f, { locked_at: "2026-11-01T10:00:00.000Z" }])) });

/**
 * AK3: the reasons a card HTML or card data breaks the content rules. Images
 * of any kind (element, CSS background, data URI, SVG <image>), a product
 * name from the test list, the word «tasting», a share function.
 */
export function cardContentProblems(text: string, productNames: string[] = PRODUCT_NAMES): string[] {
  const problems: string[] = [];
  if (/<\s*(img|picture|image|video|source|svg|canvas|object|embed|iframe)\b/i.test(text)) problems.push("image element");
  if (/background(-image)?\s*:[^;"]*url\s*\(/i.test(text) || /url\s*\(/i.test(text)) problems.push("css url()");
  if (/data:image\//i.test(text)) problems.push("data: image");
  if (/tasting/i.test(text)) problems.push("the word tasting");
  for (const p of productNames) if (text.toLowerCase().includes(p.toLowerCase())) problems.push(`product name ${p}`);
  if (/navigator\.share|\bshare\s*\(/i.test(text)) problems.push("share function");
  return problems;
}

export function runOpplevelserGardssalgMcpCardsTests(opts: { log?: boolean; print?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const print = opts.print ?? false;
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
  const assertTrue = (cond: boolean, label: string): void => assertEq(cond, true, label);

  return (async () => {
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_MCP_CARDS_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED", ...OTHER_O5_FLAGS];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    for (const k of envKeys.slice(2)) delete process.env[k];

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("./experiences-mcp"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let server: http.Server | undefined;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const origConsole = methods.map((m) => console[m]);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");
      const store = require("../services/booking-store") as typeof import("../services/booking-store");
      const receipt = require("../services/gardssalg-honest-receipt") as typeof import("../services/gardssalg-honest-receipt");

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async () => ({ success: true, messageId: "test" });

      const insert = (id: string, navn: string, live: number, f: { visit?: string; products?: string[] } = {}) => db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, epost, slug,
            enrichment_state, verification_status, source, confidence,
            opening_hours_text, visit_text, products, field_provenance)
         VALUES (?, ?, 'experiences', 'Vestland', 'Ktvik', 'Ktvik', 'cideri', ?, 'post@kt.example.no', ?, 'raw', 'pending_verify', 'test-fixture', 'medium',
                 ?, ?, ?, ?)`,
      ).run(id, navn, live, `${id.slice(0, 8)}-sideri`, f.visit ? "Lørdag 12:00-16:00" : null, f.visit ?? null,
        f.products ? JSON.stringify(f.products) : null, f.visit ? ownerLocks("opening_hours_text", "visit_text") : null);
      db.prepare("DELETE FROM experience_providers WHERE id = ?").run(TEST_PROVIDER_ID);
      insert(TEST_PROVIDER_ID, "Kttest Sideri", 1, { visit: "Omvisning i produksjonslokalet og en fortelling om gården." });
      insert("kt-off00", "Ktoff Sideri", 0);
      // AK3 source row: product names in its own visit text and product list.
      insert("kt-leak0", "Ktleak Sideri", 1, { visit: "Omvisning, og vi viser hvordan Ktfjordbris og «Gamle Ktvik» lages. Ktgull Eplemost.", products: PRODUCT_NAMES });

      const app = express();
      app.use(express.json());
      const mcpMod = require("./experiences-mcp") as typeof import("./experiences-mcp");
      const mcpRouter = mcpMod.default as any;
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => mcpRouter(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

      // node:http, not the global fetch: other suites in the gate stub it.
      function request(headers: Record<string, string>, payload: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
        return new Promise((resolve, reject) => {
          const data = JSON.stringify(payload);
          const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { ...headers, "Content-Length": String(Buffer.byteLength(data)) } }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { text += c; });
            res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text }));
          });
          req.on("error", reject);
          req.end(data);
        });
      }
      const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": CHATGPT_UA };
      async function mcp(method: string, params: unknown): Promise<any> {
        const init = await request(h, {
          jsonrpc: "2.0", method: "initialize", id: "1",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } },
        });
        const sid = init.headers["mcp-session-id"];
        const res = await request({ ...h, ...(typeof sid === "string" ? { "mcp-session-id": sid } : {}) }, { jsonrpc: "2.0", method, id: "2", params });
        const ct = res.headers["content-type"];
        return parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null).result;
      }
      const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
        const r = await mcp("tools/call", { name, arguments: args });
        await new Promise((res) => setTimeout(res, 30)); // fire-and-forget e-mails
        return r;
      };
      const payloadOf = (r: any): any => JSON.parse(String(r?.content?.[0]?.text ?? "null"));
      const slot = futureSlot(30, 13);
      let guestN = 0;
      const bookArgs = (extra: Record<string, unknown> = {}) => ({
        provider_id: TEST_PROVIDER_ID, slot_at: slot, party_size: 3, guest_name: "Kari Kort", guest_email: `kari.kort${++guestN}@example.no`, confirm_outside_hours: true, ...extra,
      });
      const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
      const nb = (iso: string | null) => receipt.formatOsloInstant(iso, "nb");
      const en = (iso: string | null) => receipt.formatOsloInstant(iso, "en");
      const slotIso = (s: string) => store.osloDatetimeLocalToUtcIso(s) ?? s;

      /** Placeholders for the values that differ per run (refs, tokens, times, guest e-mail). */
      const normalise = (result: unknown): unknown => {
        let s = JSON.stringify(result);
        const p = (() => { try { return payloadOf(result); } catch { return null; } })();
        const subs: Array<[string, string]> = [];
        const ref = p?.booking_ref;
        if (typeof ref === "string") {
          const row = store.getBookingByRef(ref);
          if (row) {
            subs.push([row.guest_email, "<EMAIL>"]);
            if (row.respond_token_expires_at) subs.push([nb(row.respond_token_expires_at), "<FRIST_NB>"], [en(row.respond_token_expires_at), "<FRIST_EN>"]);
            const st = store.guestStatusUrl(row);
            if (st) subs.push([st, "<STATUS_URL>"]);
          }
          subs.push([ref, "<REF>"]);
        }
        if (typeof p?.guest_ref === "string") subs.push([p.guest_ref, "<GUEST_REF>"]);
        subs.push([nb(slotIso(slot)), "<SLOT_NB>"], [en(slotIso(slot)), "<SLOT_EN>"]);
        if (typeof p?.slot_at_local === "string") subs.push([p.slot_at_local, "<SLOT_LOCAL>"]);
        for (let i = guestN; i > 0; i--) subs.push([`kari.kort${i}@example.no`, "<EMAIL>"]);
        for (const [from, to] of subs) if (from) s = s.split(JSON.stringify(from).slice(1, -1)).join(to);
        return JSON.parse(s);
      };
      const hashes: Record<string, Record<string, string>> = { off: {}, others_on: {} };
      const setOthers = (on: boolean) => { for (const k of OTHER_O5_FLAGS) { if (on) process.env[k] = "true"; else delete process.env[k]; } };

      // ── (ak1) flag off: byte-identical to the pre-O5-6 goldens ─────────
      type Snap = { list: any; res: any; discover: any; book: any; preview?: any; status?: any };
      const snapshot = async (others: boolean): Promise<Snap> => {
        setOthers(others);
        const s: Snap = {
          list: await mcp("tools/list", {}),
          res: await mcp("resources/list", {}),
          discover: await call("discover_gardssalg", { kommune: "Ktvik", limit: 50 }),
          book: await call("book_gardssalg", bookArgs()),
        };
        if (others) {
          s.preview = await call("book_gardssalg", bookArgs({ preview: true }));
          const b = payloadOf(s.book);
          s.status = await call("get_gardssalg_booking", { booking_ref: b.booking_ref, guest_ref: b.guest_ref });
        }
        return s;
      };
      const record = (bucket: "off" | "others_on", s: Snap) => {
        hashes[bucket]["tools/list"] = sha(s.list);
        hashes[bucket]["resources/list"] = sha(s.res);
        hashes[bucket].discover = sha(s.discover);
        hashes[bucket].book = sha(normalise(s.book));
        if (s.preview) hashes[bucket].preview = sha(normalise(s.preview));
        if (s.status) hashes[bucket].status = sha(normalise(s.status));
      };
      const offAll = await snapshot(false);
      record("off", offAll);
      const offOthers = await snapshot(true);
      record("others_on", offOthers);
      setOthers(false);
      if (print) console.log("flag-off hashes:\n" + JSON.stringify(hashes, null, 2));
      for (const bucket of ["off", "others_on"] as const) {
        for (const [k, v] of Object.entries(GOLDEN[bucket])) {
          assertEq(hashes[bucket][k], v, `ak1 (${bucket === "off" ? "all O5 flags off" : "other O5 flags on"}): ${k} byte-identical to the pre-O5-6 golden`);
        }
      }
      for (const r of [offAll.discover, offAll.book, offOthers.discover, offOthers.book, offOthers.preview, offOthers.status]) {
        assertEq(Object.keys(r ?? {}), ["content"], "ak1b: flag off: a gardssalg result has only `content` (no structuredContent, no _meta)");
      }
      assertTrue(!JSON.stringify(offOthers.res).includes("gardssalg"), "ak1c: flag off: resources/list names no card resource");
      if (print) return { passed, failed, failures };

      // ── (ak2) flag on ───────────────────────────────────────────────────
      const cards = require("./gardssalg-cards") as typeof import("./gardssalg-cards");
      process.env.GARDSSALG_MCP_CARDS_ENABLED = "true";
      setOthers(true);
      const listOn = await mcp("tools/list", {});
      const resOn = await mcp("resources/list", {});
      const uris = (resOn.resources as Array<{ uri: string }>).map((r) => r.uri);
      assertTrue(uris.includes(cards.GARDSSALG_LIST_CARD_URI) && uris.includes(cards.GARDSSALG_BOOKING_CARD_URI), "ak2: flag on: resources/list has the two card resources");
      assertEq({ ...resOn, resources: resOn.resources.filter((r: any) => !String(r.uri).includes("gardssalg")) }, offOthers.res, "ak2b: every other resource unchanged");
      const toolOn = (n: string) => listOn.tools.find((t: any) => t.name === n);
      const toolOff = (n: string) => offOthers.list.tools.find((t: any) => t.name === n);
      const metaFor = (uri: string) => ({ ui: { resourceUri: uri }, "openai/outputTemplate": uri });
      assertEq(toolOn("discover_gardssalg")._meta, metaFor(cards.GARDSSALG_LIST_CARD_URI), "ak2c: discover_gardssalg points at the producer list card");
      assertEq(toolOn("book_gardssalg")._meta, metaFor(cards.GARDSSALG_BOOKING_CARD_URI), "ak2d: book_gardssalg points at the booking card");
      assertEq(toolOn("get_gardssalg_booking")._meta, metaFor(cards.GARDSSALG_BOOKING_CARD_URI), "ak2e: get_gardssalg_booking points at the booking card");
      const changed = ["discover_gardssalg", "book_gardssalg", "get_gardssalg_booking"];
      for (const n of changed) {
        const { _meta: _x, ...rest } = toolOn(n);
        assertEq(rest, toolOff(n), `ak2f: ${n}: only _meta differs from the flag-off definition`);
      }
      assertEq(listOn.tools.filter((t: any) => !changed.includes(t.name)), offOthers.list.tools.filter((t: any) => !changed.includes(t.name)), "ak2g: every other tool unchanged");
      if (log || print) console.log("  flag-on changed tool definitions:\n" + JSON.stringify(listOn.tools.filter((t: any) => changed.includes(t.name)), null, 2));

      // discover_gardssalg
      const dOn = await call("discover_gardssalg", { kommune: "Ktvik", limit: 50 });
      assertEq(dOn.content, offOthers.discover.content, "ak2h: discover text content byte-identical with the flag on");
      const dParsed = cards.GardssalgListStructuredSchema.safeParse(dOn.structuredContent);
      assertTrue(dParsed.success, "ak2i: discover structuredContent validates against the list card schema");
      const { card: dCard, ...dRest } = dOn.structuredContent ?? {};
      assertEq(dRest, payloadOf(dOn), "ak2j: structuredContent carries the whole text payload (complete for hosts that read only it)");
      const testRow = dCard?.producers?.find((p: any) => p.id === TEST_PROVIDER_ID);
      assertEq(testRow, {
        id: TEST_PROVIDER_ID, name: "Kttest Sideri", place_type: "cideri", kommune: "Ktvik", accepts_requests: true,
        profile_url: payloadOf(dOn).gardssalg_producers.find((p: any) => p.id === TEST_PROVIDER_ID).profile_url,
      }, "ak2k: test producer: name, type of place, municipality, accepts requests, profile link");
      assertEq(dCard?.producers?.find((p: any) => p.id === "kt-off00")?.accepts_requests, false, "ak2l: paused producer: accepts_requests false");
      assertTrue(String(testRow?.profile_url).startsWith("https://opplevagent.no/"), "ak2m: profile link is on the platform's own domain");
      const empty = await call("discover_gardssalg", { kommune: "Ingensteds", limit: 5 });
      assertEq(empty.structuredContent?.card, { kind: "gardssalg_producers", producers: [] }, "ak2n: no hits: an empty list card (card.list.empty)");

      // book_gardssalg: preview, send, duplicate
      const pv = await call("book_gardssalg", bookArgs({ preview: true }));
      assertEq(normalise({ content: pv.content }), normalise(offOthers.preview), "ak2o: preview text content byte-identical with the flag on");
      assertTrue(cards.GardssalgBookingStructuredSchema.safeParse(pv.structuredContent).success, "ak2p: preview structuredContent validates against the booking card schema");
      const pvPayload = payloadOf(pv);
      assertEq(pv.structuredContent.card, {
        kind: "gardssalg_booking", preview: true, producer: "Kttest Sideri", status: null,
        time: { nb: nb(slotIso(slot)), en: en(slotIso(slot)) }, party_size: 3, booking_ref: null, status_url: null,
        preview_lines: String(pvPayload.message).split("\n").slice(1).map((l: string) => { const [n, e] = l.split(" / "); return { nb: n, en: e }; }),
      }, "ak2q: preview card: producer (to whom), time in words, party, what is shared, privacy; nothing sent");
      assertTrue(pv.structuredContent.card.preview_lines.length >= 2, "ak2r: preview card has the shares and privacy lines");

      const sent = await call("book_gardssalg", bookArgs());
      const sentPayload = payloadOf(sent);
      assertEq(normalise({ content: sent.content }), normalise(offOthers.book), "ak2s: send: text content byte-identical with the flag on");
      assertTrue(cards.GardssalgBookingStructuredSchema.safeParse(sent.structuredContent).success, "ak2t: send structuredContent validates against the booking card schema");
      assertEq(sent.structuredContent.card, {
        kind: "gardssalg_booking", preview: false, producer: "Kttest Sideri", status: "pending",
        time: { nb: nb(slotIso(slot)), en: en(slotIso(slot)) }, party_size: 3, booking_ref: sentPayload.booking_ref,
        status_url: sentPayload.status_url, preview_lines: [],
      }, "ak2u: booking card: producer, time in words, party, pending badge, reference, «Se status» link");
      const { card: _sc, ...sentRest } = sent.structuredContent;
      assertEq(sentRest, sentPayload, "ak2v: structuredContent carries the whole text payload");

      process.env.GARDSSALG_BOOKING_CAP_ENABLED = "true";
      const dupArgs = bookArgs();
      await call("book_gardssalg", dupArgs);
      const dup = await call("book_gardssalg", dupArgs);
      delete process.env.GARDSSALG_BOOKING_CAP_ENABLED;
      assertEq([payloadOf(dup).duplicate, dup.structuredContent?.card?.status, dup.structuredContent?.card?.status_url], [true, "pending", null], "ak2w: duplicate: card for the existing request, no status link (none in the text either)");

      // non-success: no card (the text answers)
      const paused = await call("book_gardssalg", bookArgs({ provider_id: "kt-off00" }));
      assertEq(Object.keys(paused), ["content"], "ak2x: a rejected request gets no structuredContent");

      // get_gardssalg_booking: every badge
      const ref = String(sentPayload.booking_ref);
      const gref = String(sentPayload.guest_ref);
      const row = () => store.getBookingByRef(ref)!;
      const badge = async (): Promise<any> => {
        const r = await call("get_gardssalg_booking", { booking_ref: ref, guest_ref: gref });
        assertTrue(cards.GardssalgBookingStructuredSchema.safeParse(r.structuredContent).success, "ak2y: status structuredContent validates against the booking card schema");
        const { card: _c, ...rest } = r.structuredContent;
        assertEq(rest, payloadOf(r), "ak2z: status structuredContent carries the whole text payload");
        return r.structuredContent.card;
      };
      const st0 = await badge();
      assertEq([st0.status, st0.status_url, st0.party_size, st0.producer], ["pending", store.guestStatusUrl(row()), 3, "Kttest Sideri"], "ak2-st1: pending");
      const setPre = (pre: string | null, status = "reserved") => db.prepare("UPDATE gardssalg_bookings SET pre_status = ?, status = ? WHERE booking_ref = ?").run(pre, status, ref);
      const want: Array<[string | null, string, string]> = [
        ["time_suggested", "reserved", "suggested"], ["provider_confirmed", "reserved", "confirmed"],
        ["provider_declined", "reserved", "declined"], ["expired", "reserved", "expired"],
      ];
      for (const [pre, status, b] of want) {
        setPre(pre, status);
        assertEq((await badge()).status, b, `ak2-st: pre_status ${pre} -> badge ${b}`);
      }
      setPre("provider_confirmed");
      const cancelMod = require("../services/gardssalg-cancel") as typeof import("../services/gardssalg-cancel");
      assertTrue(cancelMod.guestCancel(row(), "").ok, "setup: guest cancels the confirmed visit");
      assertEq((await badge()).status, "cancelled", "ak2-st: cancelled by the guest -> badge cancelled");
      const notFound = await call("get_gardssalg_booking", { booking_ref: ref, guest_ref: "x".repeat(32) });
      assertEq(Object.keys(notFound), ["content"], "ak2-st: not found: no structuredContent, no booking data");

      // unit: withdrawn and cancelled-by-producer badges, the titles
      assertEq([cards.cardBadgeForStatusKey("withdrawnByGuest"), cards.cardBadgeForStatusKey("cancelledByProducer"), cards.cardBadgeForStatusKey("cancelledByGuest")], ["withdrawn", "cancelled", "cancelled"], "ak2-st: withdrawn / cancelled badges");

      // a session registered with the flag off never gets a card, even after it is turned on
      // (its tools/list has no outputTemplate). Checked through the call-time gate:
      process.env.GARDSSALG_MCP_CARDS_ENABLED = "false";
      const dFalse = await call("discover_gardssalg", { kommune: "Ktvik", limit: 50 });
      assertEq(Object.keys(dFalse), ["content"], "flag: any value but \"true\" is off");
      process.env.GARDSSALG_MCP_CARDS_ENABLED = "true";

      // ── (ak3) content rules ─────────────────────────────────────────────
      const listHtml = (await mcp("resources/read", { uri: cards.GARDSSALG_LIST_CARD_URI })).contents[0].text as string;
      const bookingHtml = (await mcp("resources/read", { uri: cards.GARDSSALG_BOOKING_CARD_URI })).contents[0].text as string;
      assertEq(listHtml, cards.GARDSSALG_LIST_CARD_HTML, "ak3-setup: resources/read serves the list card HTML");
      assertEq(bookingHtml, cards.GARDSSALG_BOOKING_CARD_HTML, "ak3-setup: resources/read serves the booking card HTML");
      assertEq(cardContentProblems(listHtml), [], "ak3: list card HTML: no image, product name, «tasting» or share");
      assertEq(cardContentProblems(bookingHtml), [], "ak3b: booking card HTML: no image, product name, «tasting» or share");
      const leakRow = dCard?.producers?.find((p: any) => p.id === "kt-leak0");
      assertTrue(!!leakRow, "ak3-setup: the row with product names in its own data is in the card");
      assertEq(cardContentProblems(JSON.stringify(dCard)), [], "ak3c: list card data: no product name, «tasting» or image");
      assertEq(cardContentProblems(JSON.stringify(dOn.structuredContent)), [], "ak3c2: the whole discover structuredContent (visit facts on): clean");
      for (const [label, r] of [["preview", pv], ["send", sent]] as const) {
        assertEq(cardContentProblems(JSON.stringify(r.structuredContent.card)), [], `ak3d: booking card data (${label}): clean`);
      }
      const leakBook = await call("book_gardssalg", bookArgs({ provider_id: "kt-leak0", preview: true }));
      assertEq(cardContentProblems(JSON.stringify(leakBook.structuredContent?.card)), [], "ak3e: booking card for the product-name producer: clean");
      // negative controls: the check fails on each kind of breach
      const breaches = [
        listHtml.replace("</body>", '<img src="https://opplevagent.no/x.png"></body>'),
        listHtml.replace("</style>", ".c{background-image:url(/x.png)}</style>"),
        JSON.stringify({ ...dCard, producers: [{ ...testRow, name: "Ktfjordbris" }] }),
        bookingHtml.replace("</body>", "<p>Book a tasting</p></body>"),
        bookingHtml.replace("</body>", "<script>navigator.share({})</script></body>"),
      ];
      assertEq(breaches.map((b) => cardContentProblems(b).length > 0), [true, true, true, true, true], "ak3f: negative controls: image, CSS image, product name, «tasting», share each fail");
      assertTrue(!/\bkr\b|NOK|pris|price/i.test(listHtml + bookingHtml), "ak3g: the card HTML has no price wording");

      // ── (ak4) CSP metadata: no foreign domains ──────────────────────────
      const own = "https://opplevagent.no";
      const allResources = resOn.resources as Array<{ uri: string; _meta?: any }>;
      for (const uri of [cards.GARDSSALG_LIST_CARD_URI, cards.GARDSSALG_BOOKING_CARD_URI]) {
        const read = await mcp("resources/read", { uri });
        const metas = [allResources.find((r) => r.uri === uri)?._meta, read.contents[0]._meta];
        for (const [i, m] of metas.entries()) {
          const where = i === 0 ? "resources/list" : "resources/read";
          assertEq(m?.ui?.csp, { connectDomains: [], resourceDomains: [] }, `ak4: ${uri} (${where}): ui.csp loads nothing from any domain`);
          assertEq(m?.["openai/widgetCSP"], { connect_domains: [], resource_domains: [], redirect_domains: [own] }, `ak4b: ${uri} (${where}): openai/widgetCSP: only the platform's own domain, as a link target`);
          assertEq("domain" in (m?.ui ?? {}), false, `ak4c: ${uri} (${where}): no ui.domain (Claude rejects any value but its own hash)`);
          assertEq(m?.["openai/widgetDomain"], own, `ak4d: ${uri} (${where}): ChatGPT's dedicated origin is the platform's own`);
          const domains = JSON.stringify(m).match(/https?:\/\/[^"\s/]+/g) ?? [];
          assertTrue(domains.every((d) => d === own), `ak4e: ${uri} (${where}): no foreign domain anywhere in the metadata`);
        }
        assertEq(read.contents[0].mimeType, "text/html;profile=mcp-app", `ak4f: ${uri}: MCP Apps MIME type`);
        const html = read.contents[0].text as string;
        assertTrue(!/<script[^>]+src=|<link\b|@import|\bsrc\s*=|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource/i.test(html), `ak4g: ${uri}: the HTML loads no script, style or data from the network`);
        const urls = html.match(/https?:\/\/[^"'\s)\\]+/g) ?? [];
        assertTrue(urls.every((u) => u.startsWith(own + "/") || u === own), `ak4h: ${uri}: every URL in the HTML is on the platform's own domain`);
      }

      // ── (txt) OA-2 §D verbatim ──────────────────────────────────────────
      assertEq(cards.CARD_TEXTS, {
        "card.list.title": { nb: "Produsenter du kan besøke", en: "Producers you can visit" },
        "card.list.acceptsRequests": { nb: "Tar imot forespørsler", en: "Accepts visit requests" },
        "card.list.noRequests": { nb: "Kontakt produsenten direkte", en: "Contact the producer directly" },
        "card.list.requestAction": { nb: "Be om besøk", en: "Request a visit" },
        "card.list.profileAction": { nb: "Profilside", en: "Profile page" },
        "card.list.empty": { nb: "Ingen produsenter passet søket.", en: "No producers matched the search." },
        "card.list.requestPrompt": { nb: "Jeg vil be om besøk hos {produsent}.", en: "I would like to request a visit to {produsent}." },
        "card.booking.title": { nb: "Besøk hos {produsent}", en: "Visit to {produsent}" },
        "card.booking.titlePending": { nb: "Forespørsel om besøk hos {produsent}", en: "Visit request to {produsent}" },
        "card.booking.time": { nb: "Tidspunkt", en: "Time" },
        "card.booking.party": { nb: "Antall", en: "Guests" },
        "card.booking.ref": { nb: "Referanse", en: "Reference" },
        "card.booking.statusAction": { nb: "Se status", en: "See status" },
        "card.badge.pending": { nb: "Venter på svar", en: "Waiting for a reply" },
        "card.badge.confirmed": { nb: "Bekreftet", en: "Confirmed" },
        "card.badge.suggested": { nb: "Nytt tidspunkt foreslått", en: "New time suggested" },
        "card.badge.declined": { nb: "Avslått", en: "Declined" },
        "card.badge.expired": { nb: "Utløpt", en: "Expired" },
        "card.badge.cancelled": { nb: "Avlyst", en: "Cancelled" },
        "card.badge.withdrawn": { nb: "Trukket", en: "Withdrawn" },
        "card.preview.title": { nb: "Dette sendes hvis du sier ja", en: "This is sent if you say yes" },
        "card.preview.to": { nb: "Sendes til {produsent}", en: "Sent to {produsent}" },
        "card.preview.notSent": { nb: "Ingenting er sendt ennå.", en: "Nothing has been sent yet." },
      }, "txt: card texts are OA-2 §D verbatim (nb + en)");
      for (const [k, v] of Object.entries(cards.CARD_TEXTS)) {
        assertTrue((cards.GARDSSALG_LIST_CARD_HTML + cards.GARDSSALG_BOOKING_CARD_HTML).includes(JSON.stringify(v.nb).slice(1, -1)), `txt: ${k} is in a card`);
      }
      // the card never writes: its only actions are a follow-up message and opening an own-domain link
      for (const html of [listHtml, bookingHtml]) {
        assertTrue(!/tools\/call|callTool|callServerTool/.test(html), "write: a card never calls a tool itself");
      }
      assertTrue(listHtml.includes("ui/message") && bookingHtml.includes("ui/open-link"), "write: actions go as a conversation message / an opened link");
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
    } finally {
      methods.forEach((m, i) => { (console as any)[m] = origConsole[i]; });
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      restoreModuleCache();
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  const print = process.argv.includes("--print");
  runOpplevelserGardssalgMcpCardsTests({ log: !print, print }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0 && !print) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
