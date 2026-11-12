/**
 * owner-style-fixes-f.test.ts — owner pages style fixes from the 375 px
 * browser test (F-a, F-c, F-d, F-e, F-f). CSS only.
 *
 *   F-a  buttons / inputs / selects / textareas inherit the font on the
 *        portal shell (portal, Varer, Mine valg) and on «Mine ordrer», which
 *        now uses the portal's font stack.
 *   F-c  «Mine ordrer» uses the portal's light page background (#FEFAE0,
 *        = --ow-page-bg light); the dark theme still comes after it.
 *   F-d  «Mine ordrer» tabs wrap and shrink under 480 px (no hidden tab).
 *   F-e  «Legg til vare» (<summary>) has a ▸ marker that turns on [open]
 *        (CSS rendered with the form, so off-list pages stay byte-identical).
 *   F-f  the change log rows break long words (overflow-wrap: anywhere).
 *   unch the buyer's order card (ordersShell) gets none of the owner rules.
 *
 * Pure render functions, no DB. Standalone: npx tsx src/routes/owner-style-fixes-f.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOwnerStyleFixesFTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const log = opts.log !== false;
  const ok = (cond: boolean, name: string) => {
    if (cond) { passed++; if (log) console.info(`  ✓ ${name}`); }
    else { failed++; failures.push(name); if (log) console.info(`  ✗ ${name}`); }
  };

  const { portalShell } = require("./owner-portal") as typeof import("./owner-portal");
  const view = require("./owner-orders-view") as typeof import("./owner-orders-view");
  const { renderOwnerItemsSection } = require("./owner-items-card") as typeof import("./owner-items-card");

  const portal = portalShell("Eierportal · Test", `<div class="ep-card"><ul class="ep-audit-list"><li class="ep-audit-item">x</li></ul></div>`);
  const portalWithShell = portalShell("Mine valg · Test", "<p>x</p>", { ownerShellHtml: "<nav>meny</nav>" });

  const ordersOpts = {
    agentId: "a1", producerName: "Testgard", tab: "avsluttet" as const,
    counts: { venter: 12, kommende: 34, avsluttet: 56 }, orders: [], openId: null, done: "", error: "",
  };
  const ordersPlain = view.renderOrdersPage(ordersOpts);
  const ordersThemed = view.renderOrdersPage({ ...ordersOpts, ownerTheme: true, ownerShellHtml: "<nav>meny</nav>" });
  const buyerCard = view.ordersShell("Bestilling", "<h1>Bestilling</h1>");

  // F-a
  const inheritRule = "button, input, select, textarea { font-family: inherit; }";
  ok(portal.includes(inheritRule) && portalWithShell.includes(inheritRule), "F-a: portal shell form controls inherit the font (with and without the owner shell)");
  ok(
    [ordersPlain, ordersThemed].every((h) =>
      h.includes("button,input,select,textarea{font-family:inherit}") &&
      h.includes(`body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;`)),
    "F-a: «Mine ordrer» uses the portal font stack and its controls inherit it",
  );

  // F-c
  ok(
    [ordersPlain, ordersThemed].every((h) => h.includes(`Arial,sans-serif;background:#FEFAE0}`)) &&
      ordersThemed.indexOf(view.OWNER_ORDERS_PAGE_CSS) < ordersThemed.indexOf("@media (prefers-color-scheme: dark)"),
    "F-c: «Mine ordrer» light background is the portal's #FEFAE0, before the dark theme",
  );

  // F-d
  ok(
    ordersPlain.includes(".mo-tabs{flex-wrap:wrap;overflow-x:visible}") &&
      ordersPlain.includes("@media (max-width:480px){.mo-tabs{gap:4px}.mo-tab{flex:1 1 auto;padding:10px 6px;font-size:.85rem}") &&
      ordersPlain.indexOf("Venter") < ordersPlain.indexOf("Kommende") && ordersPlain.indexOf("Kommende") < ordersPlain.indexOf("Avsluttet"),
    "F-d: «Mine ordrer» tabs wrap and shrink under 480 px; tab order unchanged",
  );

  // F-e
  const items = renderOwnerItemsSection({
    agentId: "a1", now: new Date("2026-11-09T12:00:00Z"), canEdit: true,
    model: { rows: [], orderable_count: 0, total: 0, profile_reasons: [], ordersOn: true, profileEligible: true, softExpiry: false, staleDays: 30, hardStaleDays: 90, autoConfirm: false },
  });
  ok(
    items.includes(`class="ep-items-add"`) &&
      items.includes(`.ep-items-add > summary::before { content: "\\25B8";`) &&
      items.includes(".ep-items-add[open] > summary::before { transform: rotate(90deg); }"),
    "F-e: «Legg til vare» summary has a ▸ marker that rotates when open",
  );

  // F-f
  ok(portal.includes(".ep-audit-item { overflow-wrap: anywhere; word-break: break-word; }"), "F-f: change log rows break long words");

  // Unchanged: the buyer's card gets none of the owner-only orders rules.
  ok(!buyerCard.includes(view.OWNER_ORDERS_PAGE_CSS) && buyerCard.includes("background:#f5f3ee"), "unch: buyer order card CSS unchanged");

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerStyleFixesFTests().then((r) => {
    console.log(`owner-style-fixes-f: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) process.exit(1);
  });
}
