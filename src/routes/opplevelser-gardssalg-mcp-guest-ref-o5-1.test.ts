/**
 * opplevelser-gardssalg-mcp-guest-ref-o5-1.test.ts — dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter, slice O5-1.
 *
 * book_gardssalg returns the guest's secret guest_ref and status_url behind
 * GARDSSALG_MCP_GUEST_REF_ENABLED (off):
 *
 *   (c)  contract: tools/list is byte-identical with the flag off and on, and
 *        equal to the stored golden hash (this slice does not change it).
 *   (a1) flag off: the success result is byte-identical to the pre-O5-1
 *        result (golden), and nothing is stored in guest_ref_hash.
 *   (a2) flag on: guest_ref + status_url + OA-2 `book.ok` text; status_url is
 *        the receipt e-mail's link and GET returns 200 showing the request.
 *   (a3) guest_ref is never in clear in the DB row, in a log line or in an
 *        e-mail; logs carry no guest personal data.
 *   (v)  verifyGuestRef: right pair -> booking, anything else -> null.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-mcp-guest-ref-o5-1.test.ts
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

// sha256 of the tools/list `result` JSON at lokal main bd1c9e3 (before O5-1).
// A slice that changes tools/list updates this on purpose (contract rule).
const TOOLS_LIST_GOLDEN_SHA256 = "ca0b5c861ae68df2121db9fa96187301f5c5884546f6db579f0231d97b7544c3";

// OA-2 §C3 `book.ok`, copied verbatim from the approved text package.
const OA2_BOOK_OK_NB = "Forespørselen er mottatt ({ref}) og venter på svar fra {produsent}. Besøket er ikke bekreftet. Vi sender en kvittering til {e-post} og et varsel til produsenten, som svarer innen {frist}. Status: {status_url}";
const OA2_BOOK_OK_EN = "Request received ({ref}), waiting for a reply from {produsent}. The visit is not confirmed. We are sending a receipt to {e-post} and a notice to the producer, who will reply by {frist}. Status: {status_url}";

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

export function runOpplevelserGardssalgMcpGuestRefTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const assertTrue = (cond: boolean, label: string): void => assertEq(cond, true, label);

  return (async () => {
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_MCP_GUEST_REF_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED"];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    delete process.env.GARDSSALG_MCP_GUEST_REF_ENABLED;
    delete process.env.GARDSSALG_BOOKING_CAP_ENABLED;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let server: http.Server | undefined;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");
      const store = require("../services/booking-store") as typeof import("../services/booking-store");
      const receipt = require("../services/gardssalg-honest-receipt") as typeof import("../services/gardssalg-honest-receipt");

      const col = (db.prepare("PRAGMA table_info(gardssalg_bookings)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>)
        .find((c) => c.name === "guest_ref_hash");
      assertEq(col ? { notnull: col.notnull, dflt: col.dflt_value } : null, { notnull: 0, dflt: null }, "s1: gardssalg_bookings.guest_ref_hash exists, nullable, no default");

      const sent: string[] = [];
      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async (m: unknown) => { sent.push(JSON.stringify(m)); return { success: true, messageId: "test" }; };

      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES ('gr-gard', 'Refgard Sideri', 'experiences', 'Vestland', 'Ulvik', 'Ulvik', 'cideri', 1,
                 'post@refgard.example.no', 'refgard-sideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();
      const rowOf = (ref: string): Record<string, unknown> =>
        db.prepare("SELECT * FROM gardssalg_bookings WHERE booking_ref = ?").get(ref) as Record<string, unknown>;

      const app = express();
      app.use(express.json());
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default as any;
      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) =>
        (req.path === "/mcp" ? mcpRouter : seoRouter)(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

      // node:http, not the global fetch: other suites in the gate stub it.
      function request(method: string, path: string, headers: Record<string, string>, payload?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
        return new Promise((resolve, reject) => {
          const data = payload === undefined ? undefined : JSON.stringify(payload);
          const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(data ? { "Content-Length": String(Buffer.byteLength(data)) } : {}) } }, (res) => {
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
        const init = await request("POST", "/mcp", h, {
          jsonrpc: "2.0", method: "initialize", id: "1",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } },
        });
        const sid = init.headers["mcp-session-id"];
        const res = await request("POST", "/mcp", { ...h, ...(typeof sid === "string" ? { "mcp-session-id": sid } : {}) }, { jsonrpc: "2.0", method, id: "2", params });
        const ct = res.headers["content-type"];
        return parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null);
      }
      const book = async (guestName: string, guestEmail: string): Promise<string> => {
        const body = await mcp("tools/call", { name: "book_gardssalg", arguments: { provider_id: "gr-gard", slot_at: futureSlot(30), party_size: 3, guest_name: guestName, guest_email: guestEmail } });
        return String(body.result?.content?.[0]?.text ?? "");
      };

      // ── (c) tools/list contract ─────────────────────────────────────────
      const listOff = JSON.stringify((await mcp("tools/list", {})).result);
      process.env.GARDSSALG_MCP_GUEST_REF_ENABLED = "true";
      const listOn = JSON.stringify((await mcp("tools/list", {})).result);
      delete process.env.GARDSSALG_MCP_GUEST_REF_ENABLED;
      assertTrue(listOff.includes("\"book_gardssalg\""), "c1: tools/list lists book_gardssalg");
      assertTrue(listOn === listOff, "c2: tools/list byte-identical with the flag on and off");
      assertEq(createHash("sha256").update(listOff).digest("hex"), TOOLS_LIST_GOLDEN_SHA256, "c3: tools/list equals the pre-O5-1 golden");
      const bookTool = (JSON.parse(listOff).tools as Array<{ name: string; outputSchema?: unknown }>).find((t) => t.name === "book_gardssalg");
      assertEq(bookTool?.outputSchema, undefined, "c4: book_gardssalg declares no outputSchema (the new fields need no tools/list change)");

      // ── (a1) flag off: golden result ────────────────────────────────────
      const offText = await book("Ola Av", "ola.av@example.no");
      const off = JSON.parse(offText);
      const offRow = rowOf(off.booking_ref);
      assertTrue(/kl\. 11:00$/.test(String(off.slot_at_local)), "a1: slot_at_local is the requested Oslo time");
      const legacyMessage = (ref: string, email: string): string =>
        `Produsent: Refgard Sideri · Tidspunkt: ${off.slot_at_local} · 3 person(er). ` +
        `Reservasjonsforespørsel mottatt (${ref}) — status: PENDING/AVVENTER. ` +
        `En bekreftelse på forespørselen er sendt til ${email}; produsenten er varslet ` +
        `og svarer på e-post (bekrefter, foreslår nytt tidspunkt eller avslår) — reservasjonen blir ` +
        `IKKE endelig før produsenten har svart. / ` +
        `Reservation request received (${ref}) — status: PENDING. A confirmation ` +
        `email has been sent to ${email}; the producer has been notified and will ` +
        `respond by email (confirm, propose another time, or decline) — the booking only becomes ` +
        `final once the producer responds, and this tool can never confirm it itself.`;
      const golden = (ref: string, email: string) => ({
        success: true,
        pending: true,
        status: "reserved",
        booking_ref: ref,
        source: "mcp",
        confirmation_required: true,
        provider: { id: "gr-gard", navn: "Refgard Sideri", profile_url: "https://opplevagent.no/kategori/gardssalg/produsent/refgard-sideri?utm_source=chatgpt&utm_medium=mcp&utm_campaign=ai_search" },
        slot_at_local: off.slot_at_local,
        party_size: 3,
        producer_notification: { status: "queued" },
        message: legacyMessage(ref, email),
      });
      assertEq(offText, JSON.stringify(golden(off.booking_ref, "ola.av@example.no"), null, 2), "a1b: flag off: result byte-identical to the pre-O5-1 golden");
      assertEq(offRow.guest_ref_hash, null, "a1c: flag off: nothing stored in guest_ref_hash");

      // ── (a2) flag on ────────────────────────────────────────────────────
      const logged: string[] = [];
      const methods = ["log", "info", "warn", "error", "debug"] as const;
      const origConsole = methods.map((m) => console[m]);
      process.env.GARDSSALG_MCP_GUEST_REF_ENABLED = "true";
      let onText = "";
      try {
        for (const m of methods) (console as any)[m] = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? String(x.stack) : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
        onText = await book("Kari Paa", "kari.paa@example.no");
        await new Promise((r) => setTimeout(r, 50)); // fire-and-forget e-mails
      } finally {
        methods.forEach((m, i) => { (console as any)[m] = origConsole[i]; });
        delete process.env.GARDSSALG_MCP_GUEST_REF_ENABLED;
      }
      const on = JSON.parse(onText);
      const onRow = rowOf(on.booking_ref);
      const guestRef = String(on.guest_ref ?? "");
      assertTrue(/^[A-Za-z0-9_-]{32}$/.test(guestRef), "a2: flag on: guest_ref is a 32-char base64url secret");
      const appUrl = process.env.APP_URL || "https://opplevagent.no";
      const expectedStatusUrl = `${appUrl}/kategori/gardssalg/status/${encodeURIComponent(on.booking_ref)}/${onRow.guest_status_token}`;
      assertEq(on.status_url, expectedStatusUrl, "a2b: status_url is the guest's read-only status page (the receipt e-mail's link)");
      assertEq(on.status_url, store.guestStatusUrl(store.getBookingByRef(on.booking_ref)!), "a2c: status_url built by guestStatusUrl()");
      const fill = (t: string, lang: "nb" | "en") => t
        .replace("{ref}", on.booking_ref).replace("{produsent}", "Refgard Sideri").replace("{e-post}", "kari.paa@example.no")
        .replace("{frist}", receipt.formatOsloInstant(String(onRow.respond_token_expires_at), lang)).replace("{status_url}", expectedStatusUrl);
      assertEq(on.message, `${fill(OA2_BOOK_OK_NB, "nb")} / ${fill(OA2_BOOK_OK_EN, "en")}`, "a2d: message is OA-2 book.ok, filled, norsk / English");
      assertTrue(on.message.includes("Vi sender en kvittering") && !on.message.includes("er sendt"), "a2e: the e-mails are being sent, not already sent");
      const { guest_ref: _g, status_url: _s, message: _m, ...onRest } = on;
      const { message: _lm, ...goldenRest } = golden(on.booking_ref, "kari.paa@example.no");
      assertEq(onRest, goldenRest, "a2f: every other field unchanged with the flag on");
      const page = await request("GET", new URL(on.status_url).pathname, {});
      assertEq(page.status, 200, "a2g: GET status_url -> 200");
      assertTrue(page.text.includes(on.booking_ref) && page.text.includes("Refgard Sideri"), "a2h: the status page shows the request (ref + producer)");

      // ── (a3) never in clear ─────────────────────────────────────────────
      assertTrue(Object.values(onRow).every((v) => !String(v ?? "").includes(guestRef)), "a3: guest_ref is in no column of the row");
      assertEq(onRow.guest_ref_hash, createHash("sha256").update(guestRef).digest("hex"), "a3b: only its SHA-256 hex is stored");
      assertTrue(!logged.some((l) => l.includes(guestRef)), "a3c: guest_ref in no log line");
      assertTrue(!logged.some((l) => l.includes("kari.paa@example.no") || l.includes("Kari Paa")), "a3d: no guest personal data in log lines");
      assertTrue(sent.length > 0 && !sent.some((m) => m.includes(guestRef)), "a3e: guest_ref in no e-mail");

      // ── (v) verifyGuestRef ──────────────────────────────────────────────
      assertEq(store.verifyGuestRef(on.booking_ref, guestRef)?.booking_ref, on.booking_ref, "v1: right ref + guest_ref -> the booking");
      assertEq(store.verifyGuestRef(on.booking_ref, guestRef.slice(0, -1) + (guestRef.endsWith("A") ? "B" : "A")), null, "v2: wrong guest_ref -> null");
      assertEq(store.verifyGuestRef(off.booking_ref, guestRef), null, "v3: guest_ref with another ref -> null");
      assertEq(store.verifyGuestRef("GS-NOPE", guestRef), null, "v4: unknown ref -> null");
      assertEq(store.verifyGuestRef(on.booking_ref, ""), null, "v5: empty guest_ref -> null");
      assertEq(store.verifyGuestRef(on.booking_ref, undefined), null, "v6: missing guest_ref -> null");
      assertEq(store.verifyGuestRef(off.booking_ref, ""), null, "v7: booking without a hash -> null");
      const issued = store.issueGuestRef(String(offRow.booking_id));
      assertTrue(issued !== guestRef && store.verifyGuestRef(off.booking_ref, issued)?.booking_ref === off.booking_ref, "v8: issueGuestRef -> a fresh reference that verifies");
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
    } finally {
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
  runOpplevelserGardssalgMcpGuestRefTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
