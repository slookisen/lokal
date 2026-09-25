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
 * a duck-typed server — annotations only, no DB needed.
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

export function runRfbChatgptAnnotationsTests(opts: { log?: boolean } = {}): TestSummary {
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
    const fakeServer: any = {
      registerTool(name: string, config: any) { tools.set(name, config); },
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
  } catch (err: any) {
    failed++;
    failures.push("rfb-chatgpt-annotations: unexpected error: " + String(err?.stack || err?.message || err));
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-chatgpt-annotations.test.ts`
if (require.main === module) {
  const summary = runRfbChatgptAnnotationsTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  for (const f of summary.failures) console.log(f);
  process.exit(summary.failed > 0 ? 1 : 0);
}
