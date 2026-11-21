/**
 * opplevelser-gardssalg-mcp-visit-facts-o5-5.test.ts — dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter, slice O5-5.
 *
 * discover_gardssalg rows carry the producer's own opening-hours text and
 * visit description behind
 * GARDSSALG_MCP_VISIT_FACTS_ENABLED (off):
 *
 *   (ak1) flag off: tools/list equals the golden; the discover result is
 *         byte-identical to the pre-O5-5 golden; "1"/"TRUE" count as off.
 *   (ak2) flag on: the test producer's row has the fields; a producer
 *         without stated facts, with only scraped text, or with an
 *         Opplevagent-support lock has none of them; tools/list unchanged.
 *   (ak3) a source text with a product/brand name, a price or a strength
 *         never leaks into the row.
 *   (b1)  no row ever carries parsed opening windows (the parser reads one
 *         range and no negations — it would state more than the producer).
 *   (n2)  only a plain-object lock without a locker counts as owner-stated.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-mcp-visit-facts-o5-5.test.ts
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

// sha256 of the tools/list `result` JSON (same golden as O5-1..O5-4, flag off).
const TOOLS_LIST_GOLDEN_SHA256 = "ca0b5c861ae68df2121db9fa96187301f5c5884546f6db579f0231d97b7544c3";
// sha256 of the discover_gardssalg text for these fixtures before O5-5
// (computed on main 7de47c0 without this slice).
const DISCOVER_GOLDEN_SHA256 = "f7b2b45d2ae30c19065be62f8d9a5dbdbdb5292fba76959f83212bb3eefdb5ec";

const TEST_PROVIDER_ID = "0d11485a-c774-4f75-8bca-fd6e6fe19f8c";
// opening_windows is never emitted (b1); kept here so any reintroduction is caught.
const VISIT_KEYS = ["opening_hours_text", "opening_windows", "visit_description"];
const EMITTED_KEYS = ["opening_hours_text", "visit_description"];

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line in response body");
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

const CHATGPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

const ownerLocks = (...fields: string[]): string =>
  JSON.stringify({ owner_locks: Object.fromEntries(fields.map((f) => [f, { locked_at: "2026-11-01T10:00:00.000Z" }])) });
const adminLocks = (...fields: string[]): string =>
  JSON.stringify({ owner_locks: Object.fromEntries(fields.map((f) => [f, { locked_at: "2026-11-01T10:00:00.000Z", locked_by: "admin" }])) });

export function runOpplevelserGardssalgMcpVisitFactsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const envKeys = ["EXPERIENCES_DB_PATH", "GARDSSALG_MCP_VISIT_FACTS_ENABLED", "GARDSSALG_MCP_PREVIEW_ENABLED"];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    for (const k of envKeys.slice(1)) delete process.env[k];

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("./experiences-mcp"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let server: http.Server | undefined;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");

      const insert = (id: string, navn: string, f: { hours?: string; visit?: string; products?: string[]; prov?: string }) => db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, epost, slug,
            enrichment_state, verification_status, source, confidence,
            opening_hours_text, visit_text, products, field_provenance)
         VALUES (?, ?, 'experiences', 'Vestland', 'Vfvik', 'Vfvik', 'cideri', 1, 'post@vf.example.no', ?, 'raw', 'pending_verify', 'test-fixture', 'medium',
                 ?, ?, ?, ?)`,
      ).run(id, navn, id, f.hours ?? null, f.visit ?? null, f.products ? JSON.stringify(f.products) : null, f.prov ?? null);
      db.prepare("DELETE FROM experience_providers WHERE id = ?").run(TEST_PROVIDER_ID);

      const STATED_HOURS = "Lørdag 12:00-16:00";
      const STATED_VISIT = "Omvisning i produksjonslokalet og en fortelling om gården. Grupper avtaler tid på forhånd.";
      insert(TEST_PROVIDER_ID, "Vftest Sideri", { hours: STATED_HOURS, visit: STATED_VISIT, prov: ownerLocks("opening_hours_text", "visit_text") });
      insert("vf-none", "Vfnone Sideri", {});
      insert("vf-scraped", "Vfscraped Sideri", { hours: "Fredag 10-18", visit: "Omvisning hver fredag." });
      insert("vf-admin", "Vfadmin Sideri", { hours: "Fredag 10-18", visit: "Omvisning hver fredag.", prov: adminLocks("opening_hours_text", "visit_text") });
      insert("vf-hours-only", "Vfhours Sideri", { hours: "Etter avtale", visit: "Omvisning hver fredag.", prov: ownerLocks("opening_hours_text") });
      insert("vf-blank", "Vfblank Sideri", { hours: "   ", visit: "", prov: ownerLocks("opening_hours_text", "visit_text") });
      // AK3 sources: product name (own list), brand-like capitalised drink, price, strength.
      const leak = (id: string, visit: string, products?: string[]) =>
        insert(id, `Vf${id.slice(3)} Sideri`, { hours: "Søndag 11-15", visit, products, prov: ownerLocks("opening_hours_text", "visit_text") });
      leak("vf-product", "Omvisning, og vi viser deg hvordan Vfjordbris lages.", ["Vfjordbris"]);
      leak("vf-brand", "Omvisning i kjelleren der Hardangersider modnes.");
      leak("vf-price", "Omvisning for grupper, 149 kr per glass.");
      leak("vf-strength", "Omvisning i produksjonen av sider på 4,7 %.");
      leak("vf-quoted", "Omvisning og historien bak «Gamle Vfvik».");
      insert("vf-hours-price", "Vfhoursprice Sideri", { hours: "Lørdag 12-16, smaking 200,-", prov: ownerLocks("opening_hours_text") });

      const app = express();
      app.use(express.json());
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default as any;
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => mcpRouter(req, res, next));
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
      const discover = async (): Promise<string> => {
        const body = await mcp("tools/call", { name: "discover_gardssalg", arguments: { kommune: "Vfvik", limit: 50 } });
        return String(body.result?.content?.[0]?.text ?? "");
      };
      const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
      type Row = Record<string, unknown> & { id: string };
      const rowsOf = (text: string): Row[] => JSON.parse(text).gardssalg_producers;
      const rowById = (text: string, id: string): Row => rowsOf(text).find((r) => r.id === id)!;
      const visitKeysOf = (r: Row): string[] => Object.keys(r).filter((k) => VISIT_KEYS.includes(k));

      // ── (ak1) flag off ──────────────────────────────────────────────────
      const listOff = JSON.stringify((await mcp("tools/list", {})).result);
      assertEq(sha(listOff), TOOLS_LIST_GOLDEN_SHA256, "ak1: flag off: tools/list equals the golden (byte-identical)");
      const offText = await discover();
      assertEq(rowsOf(offText).length, 12, "ak1b: all twelve fixtures found");
      assertEq(sha(offText), DISCOVER_GOLDEN_SHA256, "ak1c: flag off: discover result byte-identical to the pre-O5-5 golden");
      assertTrue(rowsOf(offText).every((r) => visitKeysOf(r).length === 0), "ak1d: flag off: no row carries a visit fact");
      for (const v of ["1", "TRUE", "True", " true", "yes"]) {
        process.env.GARDSSALG_MCP_VISIT_FACTS_ENABLED = v;
        assertEq(await discover(), offText, `ak1e: flag ${JSON.stringify(v)} counts as off (byte-identical)`);
      }

      // ── (ak2) flag on ───────────────────────────────────────────────────
      process.env.GARDSSALG_MCP_VISIT_FACTS_ENABLED = "true";
      const listOn = JSON.stringify((await mcp("tools/list", {})).result);
      assertEq(sha(listOn), TOOLS_LIST_GOLDEN_SHA256, "ak2: flag on: tools/list unchanged (no outputSchema, input schema untouched)");
      const onText = await discover();
      const t = rowById(onText, TEST_PROVIDER_ID);
      assertEq(t.opening_hours_text, STATED_HOURS, "ak2b: test producer: opening_hours_text as stated");
      assertTrue(!Object.prototype.hasOwnProperty.call(t, "opening_windows"), "ak2c/b1: test producer: no opening_windows key");
      assertEq(t.visit_description, STATED_VISIT, "ak2d: test producer: visit_description as stated");
      assertEq(Object.keys(t).slice(-2), EMITTED_KEYS, "ak2e: visit facts appended after the existing fields");
      for (const id of ["vf-none", "vf-scraped", "vf-admin", "vf-blank"]) {
        assertEq(visitKeysOf(rowById(onText, id)), [], `ak2f: ${id}: no visit fields (absent, not null)`);
      }
      const hoursOnly = rowById(onText, "vf-hours-only");
      assertEq(visitKeysOf(hoursOnly), ["opening_hours_text"], "ak2g: stated hours text only; scraped visit text left out");
      // Rows minus the visit fields are byte-identical to flag off.
      const stripped = JSON.parse(onText);
      for (const r of stripped.gardssalg_producers) for (const k of VISIT_KEYS) delete r[k];
      assertEq(JSON.stringify(stripped, null, 2), offText, "ak2h: every other field byte-identical to flag off");

      // ── (ak3) content rules ─────────────────────────────────────────────
      for (const id of ["vf-product", "vf-brand", "vf-price", "vf-strength", "vf-quoted"]) {
        const r = rowById(onText, id);
        assertEq(visitKeysOf(r), ["opening_hours_text"], `ak3: ${id}: visit_description dropped, clean opening hours kept`);
      }
      assertEq(visitKeysOf(rowById(onText, "vf-hours-price")), [], "ak3b: opening hours with a price/tasting claim dropped");
      assertTrue(!/Vfjordbris|Hardangersider|149|4,7|Gamle Vfvik|200,-/.test(JSON.stringify(rowsOf(onText).map((r) => VISIT_KEYS.map((k) => r[k])))), "ak3c: no product/brand name, price or strength in any visit fact");

      const vf = require("../services/gardssalg-visit-facts") as typeof import("../services/gardssalg-visit-facts");
      const leaks = (s: string, p: string[] = []) => vf.gardssalgVisitTextLeaksDrink(s, p);
      assertTrue(
        [leaks("Kr 149 for omvisning"), leaks("NOK 200"), leaks("Billetter 150,-"), leaks("12 % vol"), leaks("Styrke 6 prosent"),
          leaks("Gullmedalje i 2025"), leaks("Gratis smaking"), leaks("Se Juleøl lages"), leaks("Vi lager Eplesider"), leaks("Omvisning ved Fjordpils", ["fjordpils"])]
          .every(Boolean),
        "ak3d: sanitiser flags price, strength, medal, tasting, capitalised drink names and own product names",
      );
      assertTrue(rowsOf(onText).every((r) => !Object.prototype.hasOwnProperty.call(r, "opening_windows")), "b1: flag on: no row has an opening_windows key");

      // ── (b1) texts the one-range parser would misread: text kept, no windows
      const B1_TEXTS = ["Stengt mandag. Åpent 10-16", "Åpent alle dager unntatt søndag 10-17", "Lørdag 12-16 og søndag 13-17", "Man-fre 10-16, lør 11-15"];
      for (const hours of B1_TEXTS) {
        const facts = vf.gardssalgVisitFacts({ opening_hours_text: hours, field_provenance: ownerLocks("opening_hours_text") });
        assertEq(facts, { opening_hours_text: hours }, `b1: ${JSON.stringify(hours)}: producer's text only, no opening_windows`);
      }

      // ── (n2) owner-stated means a plain-object lock with no locker ────────
      const stated = (prov: unknown): boolean =>
        "visit_description" in vf.gardssalgVisitFacts({ visit_text: "Omvisning hver fredag.", field_provenance: typeof prov === "string" ? prov : JSON.stringify(prov) });
      assertTrue(stated({ owner_locks: { visit_text: { locked_at: "2026-11-01" } } }), "n2: lock without locked_by counts");
      assertTrue(stated({ owner_locks: { visit_text: {} } }), "n2b: empty-object lock counts");
      assertTrue(stated({ owner_locks: { visit_text: { locked_by: null } } }), "n2c: locked_by null counts");
      for (const lockedBy of ["admin", "Admin", "system", "owner", ""]) {
        assertTrue(!stated({ owner_locks: { visit_text: { locked_by: lockedBy } } }), `n2d: locked_by ${JSON.stringify(lockedBy)} does not count`);
      }
      for (const lock of [null, "owner", ["x"], 1, true]) {
        assertTrue(!stated({ owner_locks: { visit_text: lock } }), `n2e: lock value ${JSON.stringify(lock)} does not count`);
      }
      assertTrue(!stated({ owner_locks: [{ visit_text: {} }] }), "n2f: owner_locks array does not count");
      assertTrue(!stated({ owner_locks: { opening_hours_text: {} } }), "n2g: other field's lock does not count");
      assertTrue(!stated("{not json"), "n2h: malformed provenance does not count");
      assertTrue(!("visit_description" in vf.gardssalgVisitFacts({ visit_text: "Omvisning hver fredag." })), "n2i: no provenance does not count");

      // ── (n1) extended content filter: each drops the field ───────────────
      const N1_LEAKS = [
        "Historien bak ‘Gamle Vfvik’.", "Historien bak 'Gamle Vfvik'.", "Historien bak ‹Gamle Vfvik›.",
        "Omvisning 149:- per person", "Betal i NKR", "SEK 100 per person", "Omvisning 10 euro", "Betal med €", "Omvisning for en krone",
        "Pris 150 per person", "Billett 200", "Styrke 5 pst", "0,5 ‰ restsukker", "5％",
        "Se hvordan SIDER lages", "Se hvordan IPA lages", "Eplesideren modnes i kjelleren", "Vinen fra gården", "Ølet brygges her", "Ølene våre",
      ];
      for (const text of N1_LEAKS) {
        assertTrue(leaks(text), `n1: ${JSON.stringify(text)} flagged`);
        assertEq(vf.gardssalgVisitFacts({ visit_text: text, field_provenance: ownerLocks("visit_text") }), {}, `n1b: ${JSON.stringify(text)}: field dropped`);
      }
      assertTrue(!leaks("Ola's gård har omvisning."), "n1c: a single possessive apostrophe and the name «Ola» pass");

      // ── (n6) mutant killers ─────────────────────────────────────────────
      const R = vf.__visitFactsRegexesForTesting;
      const GRATIS = "Omvisning er gratis for barn.";
      assertTrue(leaks(GRATIS) && !/smak/i.test(GRATIS), "n6: «gratis» without «smak» is flagged");
      for (const DRINK of ["Omvisning, og du kan kjøpe 33 cl på stedet.", "Ta med en 0,5 l flaske hjem."]) {
        const otherRegexHit = [R.PRICE_RE, R.STRENGTH_RE, R.CLAIM_RE, R.QUOTED_RE].some((re) => re.test(DRINK));
        assertTrue(leaks(DRINK) && !otherRegexHit, `n6b: ${JSON.stringify(DRINK)} flagged by hasDrinkSigns alone`);
      }

      assertTrue(
        [...B1_TEXTS.map((x) => leaks(x)), leaks("Omvisning i bryggeriet der vi lager øl og sider."), leaks("Lørdag 12:00-16:00"), leaks("Man-fre 10-16, lør 11-15"), leaks("Etter avtale")]
          .every((x) => !x),
        "ak3e: plain visit and opening-hours texts pass",
      );
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
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
  runOpplevelserGardssalgMcpVisitFactsTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
