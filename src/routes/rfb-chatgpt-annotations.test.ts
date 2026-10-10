/**
 * rfb-chatgpt-annotations.test.ts — ChatGPT app review 2026-09-24 (Rett fra
 * Bonden v1.0.1 rejected: "One or more of your tool's annotations do not
 * appear to match the tool's behavior").
 *
 * Pins the full annotation table the submission form's justifications
 * describe, measured against OpenAI's published definitions
 * (developers.openai.com/plugins/deploy/submission + /deploy/app-review):
 *   - openWorldHint: true when the tool "accesses the public internet …
 *     including read-only tools such as web search". lokal_search,
 *     lokal_geocode and lokal_find_offers can resolve a place name through
 *     Kartverket's public place-name API; they were declared closed-world.
 *   - destructiveHint: true when the tool can "delete, overwrite … send
 *     messages or transactions that can't be undone". lokal_cart_add_item
 *     overwrites an existing line's quantity (upsert); lokal_cart_submit
 *     e-mails producers and closes the cart. Both were declared false.
 *   - every hint must be an explicit boolean.
 *
 * Harness mirrors mcp-find-offers.test.ts: registerTools() exercised through
 * a duck-typed server — annotations, plus the outside-Norway answer that
 * returns before any DB lookup.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/rfb-chatgpt-annotations.test.ts
 *   2. Wired into tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type Hints = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };

const READ_CLOSED: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_OPEN: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** The annotation table the ChatGPT submission form's justifications describe. */
export const RFB_EXPECTED_ANNOTATIONS: Record<string, Hints> = {
  lokal_search: READ_OPEN,
  lokal_discover: READ_CLOSED,
  lokal_info: READ_CLOSED,
  lokal_stats: READ_CLOSED,
  lokal_list_umbrellas: READ_CLOSED,
  lokal_get_umbrella_members: READ_CLOSED,
  lokal_get_producer_affiliations: READ_CLOSED,
  lokal_bm_next_markets: READ_CLOSED,
  lokal_geocode: READ_OPEN,
  lokal_find_offers: READ_OPEN,
  lokal_cart_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  lokal_cart_add_item: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  lokal_cart_view: READ_CLOSED,
  lokal_cart_submit: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  lokal_order_status: READ_CLOSED,
};

export async function runRfbChatgptAnnotationsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  try {
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    const tools = new Map<string, any>();
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const fakeServer: any = {
      registerTool(name: string, config: any, handler: any) { tools.set(name, config); handlers.set(name, handler); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    };
    registerTools(fakeServer, () => "test-client", () => undefined);

    assertEq([...tools.keys()].sort(), Object.keys(RFB_EXPECTED_ANNOTATIONS).sort(),
      "a1: the exposed tool set is exactly the annotation table (a new tool needs a row + a justification)");

    for (const [name, expected] of Object.entries(RFB_EXPECTED_ANNOTATIONS)) {
      const a = tools.get(name)?.annotations ?? {};
      assertEq(
        { readOnlyHint: a.readOnlyHint, destructiveHint: a.destructiveHint, idempotentHint: a.idempotentHint, openWorldHint: a.openWorldHint },
        expected,
        `a2: ${name} annotations match the submission table`,
      );
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assertTrue(typeof a[hint] === "boolean", `a3: ${name}.${hint} is an explicit boolean`);
      }
    }

    // The submission form is filled from chatgpt-app-submission.json — its
    // annotation values must be the ones the server advertises, or the
    // justifications describe a tool the reviewer never sees.
    const submission = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "../../chatgpt-app-submission.json"), "utf8"));
    assertEq(Object.keys(submission.tools ?? {}).sort(), Object.keys(RFB_EXPECTED_ANNOTATIONS).sort(),
      "a5: chatgpt-app-submission.json lists exactly the served tools");
    for (const [name, expected] of Object.entries(RFB_EXPECTED_ANNOTATIONS)) {
      const a = submission.tools?.[name]?.annotations ?? {};
      assertEq(
        { readOnlyHint: a.readOnlyHint, destructiveHint: a.destructiveHint, openWorldHint: a.openWorldHint },
        { readOnlyHint: expected.readOnlyHint, destructiveHint: expected.destructiveHint, openWorldHint: expected.openWorldHint },
        `a6: chatgpt-app-submission.json ${name} annotations match the server`,
      );
    }

    // The three open-world read tools are open-world BECAUSE they can reach
    // Kartverket; if that dependency ever goes, the hint should be revisited.
    const geo = require("fs").readFileSync(require.resolve("../services/geocoding-service"), "utf8") as string;
    assertTrue(/ws\.geonorge\.no\/stedsnavn/.test(geo), "a4: geocodingService still calls Kartverket's public API (the reason for openWorldHint:true)");

    // ── Negative test case "pizza restaurant in Rome" (re-review
    // 2026-10-03): a place outside Norway is answered as such before any
    // DB lookup, so "Rome" can no longer substring-match Romeriksmat. ──
    const { foreignPlaceIn } = require("../services/outside-norway") as typeof import("../services/outside-norway");
    assertEq(foreignPlaceIn("Find me a good pizza restaurant in Rome"), "rome", "n1: 'Rome' is recognised as outside Norway");
    assertEq(foreignPlaceIn("safari lodge in Kenya"), "kenya", "n2: 'Kenya' is recognised as outside Norway");
    for (const q of ["ost Bergen", "Romerike", "Romsdal lam", "india pale ale", "brussels sprouts", "hamburger Oslo", "wienerbrød Trondheim", "roma tomatoes", "reindeer meat Finnmark"]) {
      assertEq(foreignPlaceIn(q), null, `n3: '${q}' is not mistaken for a place outside Norway`);
    }
    {
      const r = await handlers.get("lokal_search")!({ query: "pizza restaurant Rome", limit: 10 });
      const text = r?.content?.[0]?.text ?? "";
      assertTrue(/only covers small-scale food producers in Norway/.test(text) && !/Romeriksmat/.test(text),
        "n4: lokal_search 'pizza restaurant Rome' says it only covers Norway and lists no producer");
      const offers = await handlers.get("lokal_find_offers")!({ items: ["pizza"], near: "Rome" });
      assertTrue(/only covers small-scale food producers in Norway/.test(offers?.content?.[0]?.text ?? ""),
        "n5: lokal_find_offers near 'Rome' gets the same answer");
    }

    // ── Server instructions (ChatGPT pre-submission check 2026-10-10): the
    // negative case "Send a marketing e-mail to every producer in Vestfold"
    // got a drafted e-mail and no statement of the app's limits. initialize
    // now returns instructions that state them. ──
    {
      const express = require("express");
      const http = require("http");
      const mcpRouter = (require("./mcp") as { default: any }).default;
      const app = express();
      app.use(express.json());
      app.use("/mcp", mcpRouter);
      const srv = http.createServer(app);
      await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
      try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: "init", method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rfb-instructions-test", version: "1.0.0" } },
          }),
        });
        const text = await res.text();
        const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
        const ins = (JSON.parse(dataLine ? dataLine.slice(6) : text)?.result?.instructions ?? "") as string;
        assertTrue(/in Norway only/.test(ins), "i1: initialize instructions say Rett fra Bonden covers Norway only");
        assertTrue(/never takes payment/.test(ins), "i2: … that it never takes payment");
        assertTrue(/cannot send marketing, newsletters or bulk messages/.test(ins) && /opted in/.test(ins),
          "i3: … that it cannot send marketing or bulk messages, only the user's own order to opted-in producers");
      } finally {
        srv.close();
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("rfb-chatgpt-annotations: unexpected error: " + String(err?.stack || err?.message || err));
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-chatgpt-annotations.test.ts`
if (require.main === module) {
  runRfbChatgptAnnotationsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
