/**
 * opplevagent-chatgpt-review.test.ts — ChatGPT app review 2026-09-24
 * (Opplevagent v1.0.0 rejected: "one or more of your test cases did not
 * produce correct results … on both ChatGPT web and mobile").
 *
 * Root causes this pins, each reproduced against production on 2026-09-24:
 *   (a) The two widget templates read `window.openai.getToolOutput()`, which
 *       the ChatGPT host does not provide, and discover_experiences /
 *       get_experience returned no `structuredContent` for a widget to read —
 *       the list card said "Ingen opplevelser funnet." next to a text answer
 *       full of experiences, and the detail card was empty.
 *   (b) The templates were served as `text/html`, not the
 *       `text/html+skybridge` ChatGPT renders as a component.
 *   (c) `season:"winter"` only matched rows stored as "winter": every row
 *       stored as "vinter" (Aurora Safari Camp, Tromsø dog sledding …) and
 *       every "all_year" row dropped out of «Hva kan vi finne på i Troms om
 *       vinteren?».
 *   (d) The category description offered 'vinter' as an example slug; the
 *       real slug is 'vinter_sno', so a model copying it had the category
 *       silently relaxed away.
 *   (e) Tool annotations are asserted as an explicit table, every hint a
 *       boolean, so a future edit cannot drift from what the submission form
 *       justifies without this test failing.
 *
 * Same in-memory-DB + real-MCP-session-over-HTTP pattern as
 * opplevelser-gardssalg-mcp-discoverability.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevagent-chatgpt-review.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevagentChatgptReviewTests() and folds its counts into `npm test`.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

interface TestSummary {
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

// Plain node:http POST — deliberately not globalThis.fetch, which other
// suites in tests/test.ts stub out before this one runs.
function httpPost(url: string, body: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** The annotation table the ChatGPT submission form's justifications describe. */
export const OPPLEVAGENT_EXPECTED_ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }> = {
  discover_experiences: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_experience_categories: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_experience: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  discover_gardssalg: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  book_gardssalg: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/**
 * Runs a widget template's inline script against a minimal fake DOM and host,
 * the way ChatGPT does: `window.openai` exists but `toolOutput` is not set
 * yet; it arrives later together with an `openai:set_globals` event.
 */
function runWidget(html: string, lateToolOutput: unknown): { before: string; after: string } {
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  const listeners: Record<string, Array<() => void>> = {};
  const root = { innerHTML: "", addEventListener: () => {} };
  const fakeWindow: any = {
    openai: { theme: "light", locale: "en-US", toolOutput: null },
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ||= []).push(fn); },
    open: () => {},
  };
  const fakeDocument: any = {
    getElementById: (id: string) => (id === "root" ? root : null),
    documentElement: { lang: "no", classList: { toggle: () => {} } },
    body: { scrollHeight: 100 },
  };
  new Function("window", "document", script)(fakeWindow, fakeDocument);
  const before = root.innerHTML;
  fakeWindow.openai.toolOutput = lateToolOutput;
  for (const fn of listeners["openai:set_globals"] || []) fn();
  return { before, after: root.innerHTML };
}

export function runOpplevagentChatgptReviewTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const experiencesMcpPath = require.resolve("./experiences-mcp");
    const cachePaths = [dbFactoryPath, expStorePath, experiencesMcpPath];
    for (const p of cachePaths) delete require.cache[p];

    let server: http.Server | undefined;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      dbFactory.getDb("experiences");

      // ── (c) season spelling expansion, pure ─────────────────────────────
      const { seasonFilterSpellings } = expStore;
      assertEq(seasonFilterSpellings("winter"), ["winter", "vinter"], "c1: 'winter' expands to both spellings");
      assertEq(seasonFilterSpellings("Vinter"), ["winter", "vinter"], "c2: 'Vinter' (Norwegian, any case) expands to the same group");
      assertTrue(seasonFilterSpellings("autumn").includes("host") && seasonFilterSpellings("høst").includes("autumn"), "c3: autumn ↔ høst/host");
      assertTrue(seasonFilterSpellings("spring").includes("vaar") && seasonFilterSpellings("vår").includes("spring"), "c4: spring ↔ vår/vaar");
      assertEq(seasonFilterSpellings("monsoon"), ["monsoon"], "c5: an unknown value passes through unchanged");

      // ── Fixtures ──────────────────────────────────────────────────────
      const providerId = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const base = {
        provider_id: providerId, provider_match_status: "matched" as const, kommune: "Tromsø", fylke: "Troms",
        verification_status: "verified" as const, confidence: "high" as const,
      };
      expStore.createExperience({ ...base, title: "Nordlyscruise", category: "sightseeing_transport", season: ["autumn", "winter"], price_from: 800 });
      expStore.createExperience({ ...base, title: "Hundekjøring", category: "vinter_sno", season: ["vinter"] });
      expStore.createExperience({ ...base, title: "Rorbu hele året", category: "overnatting_opplevelse", season: ["all_year"] });
      expStore.createExperience({ ...base, title: "Midnattssol-kajakk", category: "natur_friluft", season: ["summer"] });

      const insertGardssalg = dbFactory.getDb("experiences").prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, slug, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`
      );
      insertGardssalg.run({ id: "gs-fjell", navn: "Fjellbryggeriet", fylke: "Vestland", kommune: "Bergen", poststed: "Bergen", producer_type: "bryggeri", slug: "fjellbryggeriet" });
      insertGardssalg.run({ id: "gs-ostlandet", navn: "Østlandssideri", fylke: "Innlandet", kommune: "Ringsaker", poststed: "Brumunddal", producer_type: "cideri", slug: "ostlandssideri" });

      const titlesFor = (filter: Record<string, unknown>) =>
        expStore.discoverExperiences(filter as any, 50).map((e) => e.title).sort();

      assertEq(titlesFor({ fylke: "Troms", season: "winter" }), ["Hundekjøring", "Nordlyscruise", "Rorbu hele året"],
        "c6: season 'winter' returns the 'winter' row, the 'vinter' row and the all_year row — not the summer row");
      assertEq(titlesFor({ fylke: "Troms", season: "vinter" }), ["Hundekjøring", "Nordlyscruise", "Rorbu hele året"],
        "c7: season 'vinter' returns exactly the same set");
      assertEq(titlesFor({ fylke: "Troms", season: "summer" }), ["Midnattssol-kajakk", "Rorbu hele året"],
        "c8: season 'summer' returns the summer row and the all_year row");

      // ── MCP session ───────────────────────────────────────────────────
      const mcpModule = require("./experiences-mcp") as typeof import("./experiences-mcp");
      const app = express();
      app.use(express.json());
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpModule.default as any)(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

      const baseHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      const initRes = await httpPost(url, JSON.stringify({
        jsonrpc: "2.0", method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chatgpt-review-test", version: "1.0.0" } },
        id: "init",
      }), baseHeaders);
      const sessionId = initRes.headers["mcp-session-id"] as string | undefined;
      assertTrue(!!sessionId, "s1: MCP initialize returns a session id");

      let rpcId = 0;
      async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
        const res = await httpPost(
          url,
          JSON.stringify({ jsonrpc: "2.0", method, params, id: String(++rpcId) }),
          { ...baseHeaders, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
        );
        return parseJsonRpcBody(res.text, (res.headers["content-type"] as string | undefined) ?? null);
      }

      // ── (e) annotation table ──────────────────────────────────────────
      const list = await rpc("tools/list", {});
      const tools: any[] = list.result?.tools ?? [];
      for (const [name, expected] of Object.entries(OPPLEVAGENT_EXPECTED_ANNOTATIONS)) {
        const tool = tools.find((t) => t.name === name);
        assertTrue(!!tool, `e1: tools/list exposes ${name}`);
        const a = tool?.annotations ?? {};
        assertEq(
          { readOnlyHint: a.readOnlyHint, destructiveHint: a.destructiveHint, idempotentHint: a.idempotentHint, openWorldHint: a.openWorldHint },
          expected,
          `e2: ${name} annotations match the submission table`,
        );
      }
      assertEq(tools.length, Object.keys(OPPLEVAGENT_EXPECTED_ANNOTATIONS).length, "e3: no tool outside the annotation table is exposed");
      for (const tool of tools) {
        const a = tool.annotations ?? {};
        for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
          assertTrue(typeof a[hint] === "boolean", `e4: ${tool.name}.${hint} is an explicit boolean`);
        }
      }
      const submission = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "../../opplevagent-chatgpt-app-submission.json"), "utf8"));
      assertEq(Object.keys(submission.tools ?? {}).sort(), Object.keys(OPPLEVAGENT_EXPECTED_ANNOTATIONS).sort(),
        "e7: opplevagent-chatgpt-app-submission.json lists exactly the served tools");
      for (const [name, expected] of Object.entries(OPPLEVAGENT_EXPECTED_ANNOTATIONS)) {
        const a = submission.tools?.[name]?.annotations ?? {};
        assertEq(
          { readOnlyHint: a.readOnlyHint, destructiveHint: a.destructiveHint, openWorldHint: a.openWorldHint },
          { readOnlyHint: expected.readOnlyHint, destructiveHint: expected.destructiveHint, openWorldHint: expected.openWorldHint },
          `e8: submission file ${name} annotations match the server`,
        );
      }
      const discoverTool = tools.find((t) => t.name === "discover_experiences");
      assertEq(discoverTool?._meta?.ui?.resourceUri, "ui://opplevagent/experiences-list", "e5: discover_experiences points at the list template (ui.resourceUri)");
      assertEq(discoverTool?._meta?.["openai/outputTemplate"], "ui://opplevagent/experiences-list", "e5b: … and the ChatGPT alias openai/outputTemplate");
      const getTool = tools.find((t) => t.name === "get_experience");
      assertEq(getTool?._meta?.ui?.resourceUri, "ui://opplevagent/experience-detail", "e6: get_experience points at the detail template (ui.resourceUri)");
      assertEq(getTool?._meta?.["openai/outputTemplate"], "ui://opplevagent/experience-detail", "e6b: … and the ChatGPT alias openai/outputTemplate");

      // ── (a) structuredContent on the two widget-backed tools ──────────
      const disc = await rpc("tools/call", { name: "discover_experiences", arguments: { fylke: "Troms", season: "winter" } });
      const discText = JSON.parse(disc.result?.content?.[0]?.text ?? "{}");
      assertTrue(!!disc.result?.structuredContent, "a1: discover_experiences returns structuredContent");
      assertEq(disc.result?.structuredContent, discText, "a2: structuredContent equals the JSON text block");
      assertEq(discText.count, 3, "a3: the MCP tool applies the season expansion too (winter + vinter + all_year)");

      const firstId = discText.experiences?.[0]?.id;
      const detail = await rpc("tools/call", { name: "get_experience", arguments: { id: firstId } });
      assertTrue(!!detail.result?.structuredContent?.title, "a4: get_experience returns structuredContent with a title");
      assertEq(detail.result?.structuredContent, JSON.parse(detail.result?.content?.[0]?.text ?? "{}"), "a5: get_experience structuredContent equals its JSON text block");

      // ── (d) category alias ────────────────────────────────────────────
      const byAlias = await rpc("tools/call", { name: "discover_experiences", arguments: { fylke: "Troms", category: "vinter" } });
      const byAliasText = JSON.parse(byAlias.result?.content?.[0]?.text ?? "{}");
      assertEq(byAliasText.filter_applied?.category, "vinter_sno", "d1: category 'vinter' is mapped to the real slug 'vinter_sno'");
      assertEq((byAliasText.experiences ?? []).map((e: any) => e.title), ["Hundekjøring"], "d2: … and returns only the vinter_sno row, not a relaxed list");
      assertEq(mcpModule.normalizeExperienceCategory("dyreliv_safari"), "dyreliv_safari", "d3: a real slug passes through unchanged");
      assertEq(mcpModule.normalizeExperienceCategory("Wildlife"), "dyreliv_safari", "d4: an English plain word maps to its slug");

      // ── (f) re-review 2026-10-03: the label a model shows the user, or an
      // invented slug, maps to the real slug instead of being relaxed away.
      assertEq(mcpModule.normalizeExperienceCategory("wildlife & safari"), "dyreliv_safari", "f1: the English label 'wildlife & safari' maps to dyreliv_safari");
      assertEq(mcpModule.normalizeExperienceCategory("wildlife_safari"), "dyreliv_safari", "f2: an invented slug 'wildlife_safari' maps to dyreliv_safari");
      assertEq(mcpModule.normalizeExperienceCategory("Food and drink"), "mat_drikke", "f3: 'Food and drink' maps to mat_drikke");
      assertEq(mcpModule.normalizeExperienceCategory("Sightseeing & transport"), "sightseeing_transport", "f4: 'Sightseeing & transport' maps to sightseeing_transport");
      const unknownCat = JSON.parse((await rpc("tools/call", { name: "discover_experiences", arguments: { fylke: "Troms", category: "karaoke" } })).result?.content?.[0]?.text ?? "{}");
      assertEq(unknownCat.count, 0, "f5: an unknown category returns no experiences instead of a relaxed all-category list");
      assertTrue(/Unknown category "karaoke"/.test(unknownCat.summary ?? "") && (unknownCat.valid_categories ?? []).includes("vinter_sno"),
        "f6: … and names the valid category slugs so the model can retry");
      const gsCat = JSON.parse((await rpc("tools/call", { name: "discover_experiences", arguments: { category: "gårdssalg" } })).result?.content?.[0]?.text ?? "{}");
      assertTrue(gsCat.count === 0 && /discover_gardssalg/.test(gsCat.summary ?? ""), "f7: the gårdssalg category points at discover_gardssalg");
      const lowerKommune = JSON.parse((await rpc("tools/call", { name: "discover_experiences", arguments: { kommune: "tromsø", season: "winter" } })).result?.content?.[0]?.text ?? "{}");
      assertTrue(lowerKommune.count === 3 && !lowerKommune.relaxed_filters, "f8: kommune 'tromsø' (lower case) matches 'Tromsø' without relaxing the filter");

      // ── (g) discover_gardssalg: the caller's county spelling ─────────────
      const gsNames = async (args: Record<string, unknown>) => {
        const r = await rpc("tools/call", { name: "discover_gardssalg", arguments: args });
        return (JSON.parse(r.result?.content?.[0]?.text ?? "{}").gardssalg_producers ?? []).map((p: any) => p.navn).sort();
      };
      assertEq(await gsNames({ fylke: "Vestland" }), ["Fjellbryggeriet"], "g1: fylke 'Vestland' returns the Vestland producer only");
      assertEq(await gsNames({ fylke: "vestland" }), ["Fjellbryggeriet"], "g2: fylke 'vestland' (lower case) matches too");
      assertEq(await gsNames({ fylke: "Hordaland" }), ["Fjellbryggeriet"], "g3: the pre-2020 county 'Hordaland' maps to Vestland");
      assertEq(await gsNames({ kommune: "bergen" }), ["Fjellbryggeriet"], "g4: kommune 'bergen' (lower case) matches 'Bergen'");
      assertEq(await gsNames({ query: "gårdssalg Vestland" }), ["Fjellbryggeriet"], "g5: query 'gårdssalg Vestland' becomes a Vestland county filter, not zero hits");
      assertEq(await gsNames({ query: "Fjellbryggeriet" }), ["Fjellbryggeriet"], "g6: a producer-name query still works");
      assertEq(mcpModule.splitGardssalgQuery("lokale drikkeprodusenter i Vestland"), { q: "", fylke: "Vestland" }, "g7: generic words are dropped and the county is lifted out");
      assertEq(mcpModule.splitGardssalgQuery("bryggeri Bergen"), { q: "bryggeri Bergen" }, "g8: a kommune is not mistaken for a county");

      // ── (h) negative test case "safari lodge in Kenya": a place outside
      // Norway is answered as such, never relaxed into Norwegian results ──
      const kenya = JSON.parse((await rpc("tools/call", { name: "discover_experiences", arguments: { fylke: "Kenya", category: "safari" } })).result?.content?.[0]?.text ?? "{}");
      assertTrue(kenya.count === 0 && (kenya.experiences ?? []).length === 0 && /only covers experiences and farm-sale producers in Norway/.test(kenya.summary ?? ""),
        "h1: fylke 'Kenya' returns no experiences and says Opplevagent only covers Norway");
      const nairobi = JSON.parse((await rpc("tools/call", { name: "discover_experiences", arguments: { lat: -1.29, lng: 36.82, radius_km: 100 } })).result?.content?.[0]?.text ?? "{}");
      assertTrue(nairobi.count === 0 && !nairobi.relaxed_filters, "h2: an origin outside Norway (Nairobi) is not relaxed into a Norwegian list");
      assertEq(await gsNames({ query: "Kenya" }), [], "h3: discover_gardssalg query 'Kenya' returns no producers");
      const tromso = JSON.parse((await rpc("tools/call", { name: "discover_experiences", arguments: { lat: 69.65, lng: 18.95, radius_km: 50 } })).result?.content?.[0]?.text ?? "{}");
      assertTrue(!/only covers/.test(tromso.summary ?? ""), "h4: an origin in Norway (Tromsø) is searched normally");

      // ── (i) re-review 2026-10-03: /personvern promised analytics "for up
      // to 180 days" and visit requests "as long as needed" — neither is
      // backed by any deletion job. /vilkar (22 June) still described a pure
      // discovery layer with no visit requests. Source-level checks: the
      // legal pages are static strings in experiences-seo.ts. ──
      const legalSrc = require("fs").readFileSync(require.resolve("./experiences-seo"), "utf8") as string;
      assertTrue(!/opptil 180 dager/.test(legalSrc) && !/up to 180 days/.test(legalSrc),
        "i1: /personvern no longer promises a 180-day analytics window no job enforces");
      assertTrue(/Besøksforespørsler<\/strong> \(navn, e-post, telefon, ønsket tid, antall personer og kommentar\) slettes ikke automatisk i dag/.test(legalSrc)
        && /Visit requests<\/strong> \(name, email, phone, requested time, party size and note\) are not deleted automatically today/.test(legalSrc),
        "i2: /personvern states plainly (NO + EN) that visit requests are not auto-deleted and how deletion works");
      assertTrue(/1a\. Besøksforespørsler til gårdssalg/.test(legalSrc) && /1a\. Farm-sale visit requests/.test(legalSrc)
        && /ikke<\/strong> en bekreftet booking/.test(legalSrc) && /not<\/strong> a confirmed booking/.test(legalSrc),
        "i3: /vilkar describes visit requests (NO + EN): forwarded by email, never a confirmed booking");

      // ── (b) templates: MIME type, CSP, and the host API they use ──────
      for (const uri of ["ui://opplevagent/experiences-list", "ui://opplevagent/experience-detail"]) {
        const read = await rpc("resources/read", { uri });
        const c = read.result?.contents?.[0] ?? {};
        assertEq(c.mimeType, "text/html;profile=mcp-app", `b1: ${uri} is served as an MCP Apps resource (text/html;profile=mcp-app)`);
        assertEq(c._meta?.ui?.domain, "https://opplevagent.no", `b1b: ${uri} declares the dedicated ui.domain a submission with UI requires`);
        assertTrue(!!c._meta?.ui?.csp && !!c._meta?.["openai/widgetCSP"], `b2: ${uri} declares a widget CSP (standard + ChatGPT key)`);
        assertTrue(typeof c.text === "string" && c.text.includes("ui/notifications/tool-result") && c.text.includes("ui/initialize"),
          `b3: ${uri} speaks the MCP Apps bridge (ui/initialize + ui/notifications/tool-result)`);
        assertTrue(c.text.includes("toolOutput") && c.text.includes("openai:set_globals"),
          `b3b: ${uri} also reads window.openai.toolOutput and re-renders on openai:set_globals`);
        assertTrue(!c.text.includes("getToolOutput"), `b4: ${uri} no longer calls the non-existent getToolOutput()`);
        assertTrue(!/target="_blank"/.test(c.text), `b5: ${uri} opens links via openExternal, not target=_blank`);
      }

      // ── (a) the widget scripts render late-arriving data ──────────────
      const { EXPERIENCES_LIST_HTML, EXPERIENCE_DETAIL_HTML } = require("./opplevagent-widgets") as typeof import("./opplevagent-widgets");
      const listRun = runWidget(EXPERIENCES_LIST_HTML, discText);
      assertTrue(/Loading/.test(listRun.before), "a6: list widget shows a loading state before toolOutput arrives (not 'no results')");
      assertTrue(listRun.after.includes("Nordlyscruise") && listRun.after.includes("Hundekjøring"), "a7: list widget renders the experiences once toolOutput arrives");
      const xss = runWidget(EXPERIENCES_LIST_HTML, { experiences: [{ title: "<img src=x onerror=alert(1)>", slug: "s" }] });
      assertTrue(!xss.after.includes("<img") && xss.after.includes("&lt;img"), "a8: list widget HTML-escapes data values");
      const emptyRun = runWidget(EXPERIENCES_LIST_HTML, { experiences: [] });
      assertTrue(/No experiences matched/.test(emptyRun.after), "a9: an empty result says so explicitly");
      const detailRun = runWidget(EXPERIENCE_DETAIL_HTML, detail.result?.structuredContent);
      assertTrue(detailRun.after.includes(detail.result?.structuredContent?.title), "a10: detail widget renders the experience title once toolOutput arrives");
    } catch (err: any) {
      failed++;
      failures.push("opplevagent-chatgpt-review: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevagent-chatgpt-review.test.ts`
if (require.main === module) {
  runOpplevagentChatgptReviewTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
