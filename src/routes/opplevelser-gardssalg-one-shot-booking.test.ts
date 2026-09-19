/**
 * opplevelser-gardssalg-one-shot-booking.test.ts — dev-request
 * 2026-09-16-opplevagent-en-setning-booking-via-ai (Daniel, live session
 * 2026-09-16): «man skal i realiteten kunne si "book et møte hos X fredag den
 * 20. okt klokken 10.00", og dette vil gjennomføre hele bookingsprosessen fra
 * å legge inn og sende til produsent».
 *
 * What this pins (all three surfaces share ONE implementation —
 * src/services/gardssalg-booking-resolve.ts — in front of the unchanged
 * BookingInputSchema → isBookingPaused → checkBookingSlotAllowed →
 * createBooking chain):
 *
 *   (u) unit — resolveGardssalgProviderByQuery(): exactly-one / none /
 *       ambiguous (never a guess), Unicode-aware (Ægir/ægir/Flåm), LIKE
 *       wildcards in the query are literal, catalog_hidden rows never
 *       resolve; parseWeekday / osloSlotParts / formatSlotOslo /
 *       checkRequestedWeekday (Tuesday-is-not-Friday, nearest matching
 *       dates, never a past suggestion, unknown weekday, calendar-invalid
 *       date); searchGardssalgProviders({ q }) ranking + wildcard escape.
 *   (d) discover_gardssalg (MCP) + REST /discover?category=gardssalg_smaking:
 *       rows now carry `id` (the provider_id book_gardssalg needs — it was
 *       MISSING before this dev-request), `query`/`q` looks a producer up by
 *       name, exact-name match first.
 *   (m) book_gardssalg (MCP): neither id nor query → invalid_input (isError);
 *       unknown name → provider_not_found (normal result, no row); several
 *       → provider_ambiguous + candidates (no epost, no row); stated weekday
 *       ≠ date → weekday_mismatch + suggestions (no row); resolved-by-name
 *       paused producer → not_live WITH provider name/profile_url (no row);
 *       resolved-by-name live producer → pending row, provider.navn +
 *       resolved_from_query + slot_at_local echoed, producer notified, no
 *       confirm_token leak; provider_id wins over provider_query.
 *   (r) POST /api/opplevelser/book: the same outcomes with the same payloads
 *       (400 / 200 / 201 mapping), and a plain provider_id call (the web
 *       form's path) is byte-for-byte unchanged apart from the additive
 *       provider/slot_at_local/party_size fields.
 *
 * Dates are computed RELATIVE TO NOW (≈30 days ahead) so the suite never goes
 * stale on a hardcoded future date (dev-request 2026-09-11-flere-hardkodede-
 * fremtidsdatoer-vil-ga-stale); only the pure formatter test uses a fixed
 * date, since formatting does not depend on "now".
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-gardssalg-one-shot-booking.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserGardssalgOneShotBookingTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .pop();
    if (!dataLine) throw new Error("no SSE data: line found in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

// Synthetic router.handle() shortcut for the plain REST routes — same recipe
// as opplevelser-booking-send-guard.test.ts / opplevelser-gardssalg-rest-
// discover.test.ts.
function callRoute(
  router: any,
  opts: { method?: "GET" | "POST"; url: string; body?: any },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url;
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : null });
    });
  });
}

const WEEKDAY_NB = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A future Oslo-wall-clock slot `daysAhead` days from now at 10:00, as the
 *  naked datetime-local string the booking tool takes — computed with plain
 *  Date.UTC arithmetic on the Oslo calendar date (independent of the module
 *  under test). Returns the string, its Monday-first weekday index and the
 *  y/m/d parts. */
function futureSlot(daysAhead: number, hour = 10): { slot: string; weekdayIdx: number; y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string): number => +(parts.find((p) => p.type === t)?.value ?? "0");
  const base = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + daysAhead));
  const y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
  const weekdayIdx = (base.getUTCDay() + 6) % 7;
  return { slot: `${y}-${pad2(mo)}-${pad2(d)}T${pad2(hour)}:00`, weekdayIdx, y, mo, d };
}
function shiftSlot(s: { y: number; mo: number; d: number }, days: number, hour = 10): string {
  const t = new Date(Date.UTC(s.y, s.mo - 1, s.d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}T${pad2(hour)}:00`;
}

export function runOpplevelserGardssalgOneShotBookingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-booking-resolve"),
      require.resolve("./experiences-mcp"),
      require.resolve("./opplevelser"),
    ];
    for (const p of cachePaths) delete require.cache[p];

    let server: http.Server | undefined;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const resolve = require("../services/gardssalg-booking-resolve") as typeof import("../services/gardssalg-booking-resolve");

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const emailCalls: Array<{ to: string; subject: string }> = [];
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async (o: { to: string; subject?: string }) => {
        emailCalls.push({ to: o.to, subject: o.subject || "" });
        return { success: true, messageId: "test" };
      };

      // ── Fixtures ────────────────────────────────────────────────────────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @booking_live, @catalog_hidden, @epost, @slug,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const fixtures = [
        { id: "os-fjord", navn: "Fjordgard Bryggeri", fylke: "Vestland", kommune: "Bergen", poststed: "Bergen", producer_type: "bryggeri", booking_live: 1, catalog_hidden: null, epost: "post@fjordgard.example.no", slug: "fjordgard-bryggeri" },
        { id: "os-fjord-kafe", navn: "Fjordgard Bryggeri Kafé", fylke: "Vestland", kommune: "Bergen", poststed: "Bergen", producer_type: "bryggeri", booking_live: 1, catalog_hidden: null, epost: "kafe@fjordgard.example.no", slug: "fjordgard-bryggeri-kafe" },
        { id: "os-egge-1", navn: "Egge Gård", fylke: "Trøndelag", kommune: "Steinkjer", poststed: "Steinkjer", producer_type: "cideri", booking_live: 0, catalog_hidden: null, epost: "post@egge.example.no", slug: "egge-gaard" },
        { id: "os-egge-2", navn: "Egge Gård Sideri", fylke: "Innlandet", kommune: "Lillehammer", poststed: "Lillehammer", producer_type: "cideri", booking_live: 1, catalog_hidden: null, epost: "post@egge-sideri.example.no", slug: "egge-gaard-sideri" },
        { id: "os-aegir", navn: "Ægir Bryggeri", fylke: "Vestland", kommune: "Aurland", poststed: "Flåm", producer_type: "bryggeri", booking_live: 1, catalog_hidden: null, epost: "post@aegir.example.no", slug: "aegir-bryggeri" },
        { id: "os-hidden", navn: "Skjult Testgard", fylke: "Vestland", kommune: "Bergen", poststed: "Bergen", producer_type: "bryggeri", booking_live: 1, catalog_hidden: 1, epost: "test@hidden.example.no", slug: "skjult-testgard" },
      ];
      for (const f of fixtures) insertProvider.run(f);

      function countRows(): number {
        return (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings").get() as { n: number }).n;
      }

      // ══════════════════════════════════════════════════════════════════
      // (u) unit — resolver + weekday helpers + store q filter
      // ══════════════════════════════════════════════════════════════════
      const r1 = resolve.resolveGardssalgProviderByQuery("Fjordgard Bryggeri");
      assertEq(r1.kind, "one", "u1: exact whole-name query resolves to exactly one (beats the 'Kafé' row that also matches every term)");
      assertEq(r1.kind === "one" ? r1.provider.id : null, "os-fjord", "u1b: …and it is the exact-name row");
      assertEq(r1.kind === "one" ? r1.candidates_considered : null, 2, "u1c: two candidates were considered before the exact match won");

      const r2 = resolve.resolveGardssalgProviderByQuery("fjordgard");
      assertEq(r2.kind, "ambiguous", "u2: a query matching two producers with no exact name match is ambiguous — never guessed");
      if (r2.kind === "ambiguous") {
        assertEq(r2.candidates.map((c) => c.provider_id), ["os-fjord", "os-fjord-kafe"], "u2b: candidates carry provider_id, name-prefix rank first");
        assertTrue(r2.candidates.every((c) => !("epost" in c) && !("telefon" in c)), "u2c: candidates never carry epost/telefon");
        assertEq(r2.candidates[0]?.booking, { live: true, mode: "request" }, "u2d: candidate carries honest booking status");
        assertEq(r2.candidates[0]?.profile_url, "https://opplevagent.no/kategori/gardssalg/produsent/fjordgard-bryggeri", "u2e: candidate profile_url built from slug");
      }

      assertEq(resolve.resolveGardssalgProviderByQuery("Finnes Ikke Gård").kind, "none", "u3: unknown name -> none");
      assertEq(resolve.resolveGardssalgProviderByQuery("   ").kind, "none", "u3b: blank query -> none (never a match-everything search)");
      assertEq(resolve.resolveGardssalgProviderByQuery("Skjult Testgard").kind, "none", "u3c: a catalog_hidden=1 row can never be resolved by name");
      const rHidden = resolve.resolveGardssalgProviderByQuery("Skjult Testgard", { includeHidden: true });
      assertEq(rHidden.kind === "one" ? rHidden.provider.id : rHidden.kind, "os-hidden", "u3c2: …unless the ADMIN-only includeHidden opt-in is set (booking-test-send)");
      assertEq(store.searchGardssalgProviders({ q: "Skjult" }, 20).length, 0, "u3c3: the store's default q search excludes hidden rows");
      assertEq(store.searchGardssalgProviders({ q: "Skjult", include_hidden: true }, 20).map((r) => r.id), ["os-hidden"], "u3c4: …and include_hidden is the only way in");
      assertEq(resolve.resolveGardssalgProviderByQuery("%").kind, "none", "u3d: LIKE wildcard in the query is literal, not a match-everything pattern");
      assertEq(resolve.resolveGardssalgProviderByQuery("_").kind, "none", "u3e: LIKE single-char wildcard in the query is literal too");

      const r4 = resolve.resolveGardssalgProviderByQuery("ÆGIR");
      assertEq(r4.kind === "one" ? r4.provider.id : r4.kind, "os-aegir", "u4: upper-case non-ASCII query (ÆGIR) still finds 'Ægir Bryggeri' (SQLite lower() is ASCII-only — the JS pass is Unicode-aware)");
      const r4b = resolve.resolveGardssalgProviderByQuery("flåm");
      assertEq(r4b.kind === "one" ? r4b.provider.id : r4b.kind, "os-aegir", "u4b: place (poststed) query 'flåm' resolves the producer");
      const r4c = resolve.resolveGardssalgProviderByQuery("ægir bryggeri");
      assertEq(r4c.kind === "one" ? r4c.provider.id : r4c.kind, "os-aegir", "u4c: lower-case æ matches the stored upper-case Æ");

      const r5 = resolve.resolveGardssalgProviderByQuery("Egge gård");
      assertEq(r5.kind === "one" ? r5.provider.id : r5.kind, "os-egge-1", "u5: 'Egge gård' — exact name (case-insensitive) beats 'Egge Gård Sideri'");
      assertEq(resolve.resolveGardssalgProviderByQuery("egge").kind, "ambiguous", "u5b: 'egge' alone is ambiguous between the two Egge rows");
      const r5c = resolve.resolveGardssalgProviderByQuery("egge", { kommune: "Lillehammer" });
      assertEq(r5c.kind === "one" ? r5c.provider.id : r5c.kind, "os-egge-2", "u5c: a kommune narrows an otherwise ambiguous name to one");

      // store-level q filter: ranking + set + wildcard escape
      const q1 = store.searchGardssalgProviders({ q: "bryggeri" }, 20).map((r) => r.id);
      assertEq([...q1].sort(), ["os-aegir", "os-fjord", "os-fjord-kafe"], "u6: q='bryggeri' matches every visible bryggeri by name, never the hidden row");
      const q2 = store.searchGardssalgProviders({ q: "Fjordgard Bryggeri" }, 20).map((r) => r.id);
      assertEq(q2, ["os-fjord", "os-fjord-kafe"], "u6b: exact whole-name match is ranked first");
      assertEq(store.searchGardssalgProviders({ q: "%" }, 20).length, 0, "u6c: '%' is escaped — matches nothing (no row contains a literal %)");
      assertEq(store.searchGardssalgProviders({ q: "bryggeri", fylke: "Vestland", booking_live: true }, 20).length, 3, "u6d: q composes with the existing fylke/booking_live filters");
      assertEq(store.gardssalgQueryTerms("  Egge   Gård  "), ["egge", "gård"], "u6e: gardssalgQueryTerms lower-cases + splits on whitespace");
      assertEq(store.gardssalgLikePattern("æ%_\\x"), "_\\%\\_\\\\x", "u6f: gardssalgLikePattern escapes LIKE metacharacters and wildcards non-ASCII chars");

      // weekday helpers
      assertEq(resolve.parseWeekday("fredag"), 4, "u7: parseWeekday nb");
      assertEq(resolve.parseWeekday("Fre."), 4, "u7b: abbreviation with trailing dot");
      assertEq(resolve.parseWeekday("Friday"), 4, "u7c: english");
      assertEq(resolve.parseWeekday("på fredag"), 4, "u7d: leading 'på' stripped");
      assertEq(resolve.parseWeekday("søndag"), 6, "u7e: søndag = 6 (Monday-first)");
      assertEq(resolve.parseWeekday("blursday"), null, "u7f: unknown weekday -> null");
      assertEq(resolve.parseWeekday(""), null, "u7g: empty -> null");

      const p1 = resolve.osloSlotParts("2026-10-20T10:00");
      assertEq(p1 ? p1.weekday : null, 1, "u8: 20 October 2026 is a TUESDAY (the dev-request's own example says 'fredag den 20. okt')");
      assertEq(resolve.formatSlotOslo("2026-10-20T10:00"), "tirsdag 20. oktober 2026 kl. 10:00", "u8b: formatSlotOslo renders Norwegian weekday/month, Oslo wall time");
      assertEq(resolve.formatSlotOslo("2026-10-20T08:00:00.000Z"), "tirsdag 20. oktober 2026 kl. 10:00", "u8c: a UTC instant is rendered in Oslo time (+02:00 in October before DST ends)");
      assertEq(resolve.formatSlotOslo("2026-12-24T16:30"), "torsdag 24. desember 2026 kl. 16:30", "u8d: another fixed date/time renders as expected");
      assertEq(resolve.osloSlotParts("2026-02-31T10:00"), null, "u8e: calendar-invalid date (31 Feb) -> null, never rolled over");
      assertEq(resolve.formatSlotOslo("garbage"), "", "u8f: unparseable -> empty string");
      assertEq(resolve.toDatetimeLocal({ y: 2026, mo: 3, d: 7, h: 9, mi: 5 }), "2026-03-07T09:05", "u8g: toDatetimeLocal pads");

      const fixedNow = new Date("2026-09-16T12:00:00Z");
      const w1 = resolve.checkRequestedWeekday("2026-10-20T10:00", "fredag", fixedNow);
      assertEq(w1.ok, false, "u9: 'fredag' + 2026-10-20 (a Tuesday) -> not ok");
      if (!w1.ok && w1.reason === "weekday_mismatch") {
        assertEq(w1.mismatch.requested_weekday, "fredag", "u9b: requested weekday echoed (normalised)");
        assertEq(w1.mismatch.actual_weekday, "tirsdag", "u9c: actual weekday reported");
        assertEq(w1.mismatch.suggestions.map((s) => s.slot_at), ["2026-10-16T10:00", "2026-10-23T10:00"], "u9d: nearest Fridays before/after at the same time");
        assertEq(w1.mismatch.suggestions[1]?.slot_at_local, "fredag 23. oktober 2026 kl. 10:00", "u9e: suggestions carry the human-readable form");
        assertEq(w1.mismatch.slot_at_local, "tirsdag 20. oktober 2026 kl. 10:00", "u9f: the offending slot is rendered too");
      } else {
        assertTrue(false, "u9b-f: expected reason weekday_mismatch");
      }
      assertEq(resolve.checkRequestedWeekday("2026-10-23T10:00", "fredag", fixedNow), { ok: true, actual_weekday: "fredag" }, "u10: matching weekday -> ok");
      assertEq(resolve.checkRequestedWeekday("2026-10-20T10:00", undefined, fixedNow), { ok: true }, "u10b: no stated weekday -> nothing to check");
      assertEq(resolve.checkRequestedWeekday("2026-10-20T10:00", "   ", fixedNow), { ok: true }, "u10c: blank stated weekday -> nothing to check");
      const w2 = resolve.checkRequestedWeekday("2026-10-20T10:00", "blursday", fixedNow);
      assertEq(!w2.ok && w2.reason, "unknown_weekday", "u10d: unknown weekday word -> unknown_weekday");
      const w3 = resolve.checkRequestedWeekday("2026-09-17T10:00", "fredag", fixedNow); // Thu 17 Sep 2026; prev Fri 11 Sep is past
      assertEq(!w3.ok && w3.reason === "weekday_mismatch" ? w3.mismatch.suggestions.map((s) => s.slot_at) : null, ["2026-09-18T10:00"], "u10e: a suggestion in the past (relative to now) is dropped");
      assertEq(resolve.checkRequestedWeekday("not-a-date", "fredag", fixedNow), { ok: true }, "u10f: unparseable slot -> ok here (the hard bounds check downstream owns that error)");

      // ══════════════════════════════════════════════════════════════════
      // Real MCP session over HTTP
      // ══════════════════════════════════════════════════════════════════
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default;
      const app = express();
      app.use(express.json());
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpRouter as any)(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const initRes = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "one-shot-booking-test-client", version: "1.0.0" } },
          id: "1",
        }),
      });
      assertTrue(initRes.ok, `init: MCP initialize returns 2xx (got ${initRes.status})`);
      const sessionId = initRes.headers.get("mcp-session-id");
      await initRes.text();

      async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
        const res = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: String(Math.random()) }),
        });
        return parseJsonRpcBody(await res.text(), res.headers.get("content-type"));
      }
      async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ body: any; parsed: any }> {
        const body = await rpc("tools/call", { name, arguments: args });
        assertTrue(!("error" in body), `${name}: no top-level JSON-RPC error (got ${JSON.stringify(body.error)})`);
        const text = body.result?.content?.[0]?.text;
        assertTrue(typeof text === "string", `${name}: returns a text content block`);
        return { body, parsed: JSON.parse(text) };
      }

      // ── tools/list advertises the new fields ─────────────────────────
      const list = await rpc("tools/list", {});
      const tools: any[] = list.result?.tools ?? [];
      const bookTool = tools.find((t) => t.name === "book_gardssalg");
      const discTool = tools.find((t) => t.name === "discover_gardssalg");
      assertTrue(!!bookTool && !!discTool, "l1: both gårdssalg tools are listed");
      assertTrue(!!bookTool?.inputSchema?.properties?.provider_query, "l2: book_gardssalg advertises provider_query");
      assertTrue(!!bookTool?.inputSchema?.properties?.requested_weekday, "l3: book_gardssalg advertises requested_weekday");
      assertTrue(!(bookTool?.inputSchema?.required ?? []).includes("provider_id"), "l4: provider_id is no longer required (provider_query is the alternative)");
      assertTrue(!!discTool?.inputSchema?.properties?.query, "l5: discover_gardssalg advertises query");
      assertTrue(/ONE-SENTENCE FLOW/.test(bookTool?.description ?? ""), "l6: book_gardssalg's description documents the one-sentence flow");
      assertTrue(/never invent/i.test(bookTool?.description ?? ""), "l7: …and tells the assistant never to invent guest details");

      // ── (d) discover_gardssalg: id + query ────────────────────────────
      const d1 = await callTool("discover_gardssalg", { fylke: "Vestland" });
      assertTrue((d1.parsed.gardssalg_producers as any[]).every((p) => typeof p.id === "string" && p.id.length > 0), "d1: every discover_gardssalg row now carries `id` (the provider_id book_gardssalg needs — it was missing)");
      assertTrue(!(d1.parsed.gardssalg_producers as any[]).some((p) => p.id === "os-hidden"), "d1b: the hidden row is still never returned");

      const d2 = await callTool("discover_gardssalg", { query: "Fjordgard Bryggeri" });
      assertEq(d2.parsed.count, 2, "d2: query 'Fjordgard Bryggeri' matches both Fjordgard rows");
      assertEq(d2.parsed.gardssalg_producers?.[0]?.id, "os-fjord", "d2b: exact-name row first");
      assertEq(d2.parsed.filter_applied?.q, "Fjordgard Bryggeri", "d2c: filter_applied echoes the query as q");

      const d3 = await callTool("discover_gardssalg", { query: "Egge gård", producer_type: "cideri", fylke: "Trøndelag" });
      assertEq((d3.parsed.gardssalg_producers as any[]).map((p) => p.id), ["os-egge-1"], "d3: query composes with the existing structured filters");
      const d4 = await callTool("discover_gardssalg", { query: "Finnes Ikke" });
      assertEq(d4.parsed.count, 0, "d4: no match -> honest count 0");

      // ── (m) book_gardssalg ────────────────────────────────────────────
      const ahead = futureSlot(30);
      const actualName = WEEKDAY_NB[ahead.weekdayIdx]!;
      const wrongIdx = (ahead.weekdayIdx + 1) % 7;
      const wrongName = WEEKDAY_NB[wrongIdx]!;
      const guest = { party_size: 4, guest_name: "Kari Nordmann", guest_email: "kari@example.no" };

      const m1 = await callTool("book_gardssalg", { slot_at: ahead.slot, ...guest });
      assertEq(m1.parsed.error, "invalid_input", "m1: neither provider_id nor provider_query -> invalid_input");
      assertTrue(m1.body.result?.isError === true, "m1b: …marked isError (unusable input)");
      assertEq(countRows(), 0, "m1c: no row created");

      const m2 = await callTool("book_gardssalg", { provider_query: "Finnes Ikke Gård", slot_at: ahead.slot, ...guest });
      assertEq(m2.parsed.reason, "provider_not_found", "m2: unknown producer name -> provider_not_found");
      assertEq(m2.parsed.success, false, "m2b: success:false");
      assertTrue(m2.body.result?.isError !== true, "m2c: …a normal result, not a protocol error");
      assertTrue(typeof m2.parsed.message === "string" && m2.parsed.message.includes("Finnes Ikke Gård"), "m2d: message names the query");
      assertEq(countRows(), 0, "m2e: no row created");

      const m3 = await callTool("book_gardssalg", { provider_query: "fjordgard", slot_at: ahead.slot, ...guest });
      assertEq(m3.parsed.reason, "provider_ambiguous", "m3: two matching producers -> provider_ambiguous");
      assertEq(m3.parsed.ambiguous, true, "m3b: ambiguous:true flag");
      assertEq((m3.parsed.candidates as any[]).map((c) => c.provider_id), ["os-fjord", "os-fjord-kafe"], "m3c: candidates carry provider_id for the resubmit");
      assertTrue((m3.parsed.candidates as any[]).every((c) => !("epost" in c)), "m3d: candidates never leak epost");
      assertTrue(/Kafé/.test(m3.parsed.message), "m3e: message lists the candidate names for the guest");
      assertEq(countRows(), 0, "m3f: no row created");

      const m4 = await callTool("book_gardssalg", { provider_query: "Fjordgard Bryggeri", slot_at: ahead.slot, requested_weekday: wrongName, ...guest });
      assertEq(m4.parsed.reason, "weekday_mismatch", `m4: stated '${wrongName}' vs a ${actualName} -> weekday_mismatch`);
      assertEq(m4.parsed.weekday_mismatch, true, "m4b: weekday_mismatch:true flag");
      assertEq(m4.parsed.actual_weekday, actualName, "m4c: actual weekday reported");
      assertEq(m4.parsed.requested_weekday, wrongName, "m4d: requested weekday echoed");
      assertEq((m4.parsed.suggestions as any[]).map((s) => s.slot_at), [shiftSlot(ahead, -6), shiftSlot(ahead, 1)], "m4e: suggestions = nearest earlier + later date on the stated weekday, same time");
      assertTrue(m4.body.result?.isError !== true, "m4f: …a normal result");
      assertEq(countRows(), 0, "m4g: no row created");

      const m4x = await callTool("book_gardssalg", { provider_query: "Fjordgard Bryggeri", slot_at: ahead.slot, requested_weekday: "blursday", ...guest });
      assertEq(m4x.parsed.error, "invalid_input", "m4x: unknown weekday word -> invalid_input");
      assertTrue(m4x.body.result?.isError === true, "m4x-b: …isError");
      assertEq(countRows(), 0, "m4x-c: no row created");

      const m5 = await callTool("book_gardssalg", { provider_query: "Egge gård", slot_at: ahead.slot, requested_weekday: actualName, ...guest });
      assertEq(m5.parsed.reason, "not_live", "m5: resolved-by-name producer with booking_live=0 -> not_live (the existing gate, unchanged)");
      assertEq(m5.parsed.provider?.navn, "Egge Gård", "m5b: …and the response names WHICH producer");
      assertEq(m5.parsed.provider?.profile_url, "https://opplevagent.no/kategori/gardssalg/produsent/egge-gaard", "m5c: …with the profile link for the guest");
      assertEq(m5.parsed.provider?.resolved_from_query, "Egge gård", "m5d: …and records that it was resolved from the query");
      assertTrue(/Egge Gård/.test(m5.parsed.message) && /profilsiden/.test(m5.parsed.message), "m5e: message carries the name and the profile hint");
      assertEq(countRows(), 0, "m5f: no row created");

      emailCalls.length = 0;
      const m6 = await callTool("book_gardssalg", { provider_query: "Fjordgard Bryggeri", slot_at: ahead.slot, requested_weekday: actualName, ...guest, notes: "Vi kommer med bil" });
      assertEq(m6.parsed.success, true, "m6: the one-sentence call succeeds against a live producer resolved by NAME");
      assertEq(m6.parsed.pending, true, "m6b: pending:true (never confirmed by the tool)");
      assertEq(m6.parsed.status, "reserved", "m6c: status reserved");
      assertEq(m6.parsed.provider?.id, "os-fjord", "m6d: provider.id is the resolved row");
      assertEq(m6.parsed.provider?.navn, "Fjordgard Bryggeri", "m6e: provider.navn echoed");
      assertEq(m6.parsed.provider?.resolved_from_query, "Fjordgard Bryggeri", "m6f: resolved_from_query echoed");
      assertEq(m6.parsed.party_size, 4, "m6g: party_size echoed");
      assertEq(m6.parsed.slot_at_local, `${actualName} ${ahead.d}. ${resolve.formatSlotOslo(ahead.slot).split(" ")[2]} ${ahead.y} kl. 10:00`, "m6h: slot_at_local is the Norwegian rendering of the requested slot");
      assertTrue(new RegExp(`^${actualName} ${ahead.d}\\. [a-zæøå]+ ${ahead.y} kl\\. 10:00$`).test(m6.parsed.slot_at_local), "m6h2: slot_at_local shape «<ukedag> <d>. <måned> <år> kl. HH:MM»");
      assertTrue(typeof m6.parsed.message === "string" && m6.parsed.message.startsWith("Produsent: Fjordgard Bryggeri · Tidspunkt: "), "m6i: message opens with producer + time for the assistant to read back");
      assertTrue(!("confirm_token" in m6.parsed) && !("confirm_url" in m6.parsed) && !("respond_token" in m6.parsed), "m6j: no producer credential leaks into the tool response");
      assertEq(countRows(), 1, "m6k: exactly one row created");
      const row = db.prepare("SELECT provider_id, source, party_size, notes, guest_email FROM gardssalg_bookings WHERE booking_ref = ?").get(m6.parsed.booking_ref) as any;
      assertEq(row?.provider_id, "os-fjord", "m6l: the row targets the resolved provider");
      assertEq(row?.source, "mcp", "m6m: channel stamped mcp");
      assertEq(row?.notes, "Vi kommer med bil", "m6n: notes stored");
      assertEq(emailCalls.map((e) => e.to).sort(), ["kari@example.no", "post@fjordgard.example.no"].sort(), "m6o: guest receipt + PRODUCER notification both sent (the 'sende til produsent' half)");

      const m7 = await callTool("book_gardssalg", { provider_id: "os-aegir", provider_query: "Fjordgard Bryggeri", slot_at: ahead.slot, ...guest });
      assertEq(m7.parsed.success, true, "m7: provider_id + provider_query both given -> accepted");
      assertEq(m7.parsed.provider?.id, "os-aegir", "m7b: provider_id WINS over provider_query (existing callers unaffected)");
      assertTrue(!("resolved_from_query" in (m7.parsed.provider ?? {})), "m7c: no resolved_from_query when provider_id was given");
      assertEq(countRows(), 2, "m7d: second row created");

      // ══════════════════════════════════════════════════════════════════
      // (r) REST: /discover q + id, POST /book same outcomes
      // ══════════════════════════════════════════════════════════════════
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const rd1 = await callRoute(opplevelserRouter, { method: "GET", url: "/discover?category=gardssalg_smaking&q=fjordgard" });
      assertEq(rd1.status, 200, "r1: REST /discover q -> 200");
      assertEq(rd1.body?.count, 2, "r1b: q=fjordgard -> both Fjordgard rows");
      assertEq((rd1.body?.results as any[])?.map((p) => p.id), ["os-fjord", "os-fjord-kafe"], "r1c: rows carry id, exact/prefix-ranked");
      assertEq(rd1.body?.query?.q, "fjordgard", "r1d: echoed filter carries q");
      const rd2 = await callRoute(opplevelserRouter, { method: "GET", url: "/discover?category=gardssalg_smaking&fylke=Vestland" });
      assertTrue((rd2.body?.results as any[]).every((p) => typeof p.id === "string"), "r2: every REST gårdssalg row carries id");

      const rb1 = await callRoute(opplevelserRouter, { url: "/book", body: { slot_at: ahead.slot, ...guest } });
      assertEq(rb1.status, 400, "r3: POST /book without provider_id/provider_query -> 400");
      assertEq(rb1.body?.error, "invalid_input", "r3b: …invalid_input payload");

      const rb2 = await callRoute(opplevelserRouter, { url: "/book", body: { provider_query: "Finnes Ikke", slot_at: ahead.slot, ...guest } });
      assertEq(rb2.status, 200, "r4: unknown name -> 200 (honest non-success, like paused)");
      assertEq(rb2.body?.reason, "provider_not_found", "r4b: provider_not_found");

      const rb3 = await callRoute(opplevelserRouter, { url: "/book", body: { provider_query: "fjordgard", slot_at: ahead.slot, ...guest } });
      assertEq(rb3.status, 200, "r5: ambiguous -> 200");
      assertEq(rb3.body?.reason, "provider_ambiguous", "r5b: provider_ambiguous");
      assertEq((rb3.body?.candidates as any[])?.length, 2, "r5c: candidates listed");

      const rb4 = await callRoute(opplevelserRouter, { url: "/book", body: { provider_query: "Fjordgard Bryggeri", slot_at: ahead.slot, requested_weekday: wrongName, ...guest } });
      assertEq(rb4.status, 200, "r6: weekday mismatch -> 200");
      assertEq(rb4.body?.reason, "weekday_mismatch", "r6b: weekday_mismatch");
      assertEq((rb4.body?.suggestions as any[])?.map((s) => s.slot_at), [shiftSlot(ahead, -6), shiftSlot(ahead, 1)], "r6c: same suggestions as the MCP tool");

      const rb5 = await callRoute(opplevelserRouter, { url: "/book", body: { provider_query: "Fjordgard Bryggeri", slot_at: ahead.slot, requested_weekday: "blursday", ...guest } });
      assertEq(rb5.status, 400, "r7: unknown weekday word -> 400");

      const rb6 = await callRoute(opplevelserRouter, { url: "/book", body: { provider_query: "Egge gård", slot_at: ahead.slot, ...guest } });
      assertEq(rb6.status, 200, "r8: paused producer resolved by name -> 200");
      assertEq(rb6.body?.paused, true, "r8b: paused:true (existing contract)");
      assertEq(rb6.body?.provider?.navn, "Egge Gård", "r8c: …now with the producer's name");
      assertEq(countRows(), 2, "r8d: no new rows from any of the above");

      emailCalls.length = 0;
      const rb7 = await callRoute(opplevelserRouter, { url: "/book", body: { provider_query: "Fjordgard Bryggeri", slot_at: ahead.slot, requested_weekday: actualName, party_size: 2, guest_name: "Ola Nordmann", guest_email: "ola@example.no" } });
      assertEq(rb7.status, 201, "r9: REST one-sentence booking -> 201");
      assertEq(rb7.body?.success, true, "r9b: success:true");
      assertEq(rb7.body?.provider?.id, "os-fjord", "r9c: provider resolved by name");
      assertEq(rb7.body?.provider?.resolved_from_query, "Fjordgard Bryggeri", "r9d: resolved_from_query echoed");
      assertEq(rb7.body?.party_size, 2, "r9e: party_size echoed");
      assertTrue(typeof rb7.body?.slot_at_local === "string" && rb7.body.slot_at_local.startsWith(actualName), "r9f: slot_at_local rendered");
      assertTrue(!("confirm_token" in (rb7.body ?? {})) && !("confirm_url" in (rb7.body ?? {})), "r9g: no credential leak");
      assertEq(countRows(), 3, "r9h: row created");
      const rrow = db.prepare("SELECT provider_id, source FROM gardssalg_bookings WHERE booking_ref = ?").get(rb7.body.booking_ref) as any;
      assertEq(rrow?.provider_id, "os-fjord", "r9i: row targets the resolved provider");
      assertEq(rrow?.source, "opplevagent", "r9j: REST keeps the web channel stamp");
      assertEq(emailCalls.map((e) => e.to).sort(), ["ola@example.no", "post@fjordgard.example.no"].sort(), "r9k: guest + producer notified");

      const rb8 = await callRoute(opplevelserRouter, { url: "/book", body: { provider_id: "os-aegir", slot_at: ahead.slot, party_size: 1, guest_name: "Web Skjema", guest_email: "web@example.no" } });
      assertEq(rb8.status, 201, "r10: the web form's provider_id path is unchanged -> 201");
      assertEq(rb8.body?.provider?.id, "os-aegir", "r10b: provider echoed");
      assertTrue(!("resolved_from_query" in (rb8.body?.provider ?? {})), "r10c: no resolved_from_query on a provider_id call");
      assertEq(Object.keys(rb8.body).sort(), ["booking_ref", "message", "party_size", "provider", "slot_at_local", "source", "status", "success"], "r10d: response keys = the pre-existing five + the three additive fields, nothing else");
      assertEq(countRows(), 4, "r10e: row created");
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
      for (const p of cachePaths) delete require.cache[p];
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOneShotBookingTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
