/**
 * owner-tekstpakke-a.test.ts — tekstpakke A (approved owner texts, 2026-11-09;
 * dev-request 2026-10-30-rfb-eierportal-testrunde-1, D3).
 *
 *   p1-*   «Slik fungerer bestillinger» (ORDER_CAP_V2_ENABLED): the heading and
 *          the four limit lines, «per dag», never «døgn» (the «hindre misbruk»
 *          opening was dropped in tekstpakke B punkt 1).
 *   p2-*   level preview «Godt å vite» (the constant in page.ts).
 *   p3-*   «Du har ingen varer som kan bestilles ennå.» (both variants).
 *   p4-6   Varer texts (owner-items-view).
 *   p7-*   «Mine ordrer»: banners after an action, empty lists, auto-close hint.
 *   p8-*   the short order page (link in «Ny henteordre»).
 *   p9-*   «Avslå – utsolgt» legend (source of the three surfaces; the rendered
 *          surfaces are asserted in bestillinger-b2b1.test.ts).
 *   fb-*   F-b: no «← Eierportalen» in «Mine ordrer» when the owner shell is shown.
 *
 * Pure render functions and constants; no DB. Every flag it touches is restored.
 * Standalone: npx tsx src/routes/owner-tekstpakke-a.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = ["ORDER_AUTOCOMPLETE_ENABLED", "ORDER_MESSAGES_ENABLED", "STOCK_SOFT_EXPIRY_ENABLED"];

export async function runOwnerTekstpakkeATests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const log = opts.log !== false;
  const ok = (cond: boolean, name: string) => {
    if (cond) { passed++; if (log) console.log(`  ✓ ${name}`); }
    else { failed++; failures.push(name); if (log) console.log(`  ✗ ${name}`); }
  };
  const swap = (cond: boolean, newText: string, oldText: string, html: string, name: string) =>
    ok(cond && html.includes(newText) && !html.includes(oldText), name);
  const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

  const saved: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) saved[k] = process.env[k];
  try {
    for (const k of SAVED_ENV) delete process.env[k];

    // ── 1. «Slik fungerer bestillinger» (V2 branch) ──────────────────────────
    const texts = require("../owner-features/order-texts") as typeof import("../owner-features/order-texts");
    const lines = [texts.OWNER_ORDER_LIMITS_HEADING, ...texts.ownerOrderLimitLines({ openPerBuyer: 3, perBuyerPerDay: 10, producerCeilingPerDay: 50 })];
    const expected = [
      "Hvor mange bestillinger kan du få?",
      "Mange ulike kunder kan bestille fra deg samme dag.",
      "Én kunde kan ha høyst 3 ubesvarte bestillinger hos deg om gangen, og sende deg høyst 10 nye bestillinger per dag.",
      "Får du flere enn 50 bestillinger på én dag, tar vi ikke imot flere til deg resten av dagen. Kundene får da kontaktinformasjonen din i stedet.",
      "En dag regnes fra midnatt til midnatt.",
    ];
    ok(JSON.stringify(lines) === JSON.stringify(expected), "p1-01: the heading and the four limit lines are the approved text (defaults 3/10/50)");
    const joined = lines.join(" ");
    ok(!joined.includes("misbruk") && !joined.includes("døgn") && joined.includes("per dag"), "p1-02: no «misbruk» (tekstpakke B), «per dag», no «døgn»");

    // ── 2. Level preview «Godt å vite» ───────────────────────────────────────
    const pageSrc = src("owner-features/page.ts");
    swap(true, "Du kan gjøre unntak etterpå. Trykker du «Angre», går hele nivåbyttet tilbake.",
      "«Angre» angrer hele nivåbyttet", pageSrc, "p2-01: «Godt å vite» has the new sentence, not the old");

    // ── 3. «Du har ingen varer som kan bestilles ennå.» ─────────────────────
    const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
    ok(ch.OWNER_LEVEL_SOFT_TEXTS.no_orderable_products.no === "Du har ingen varer som kan bestilles ennå. Kundene kan ikke bestille før du har lagt inn varer.",
      "p3-01: the preview warning has the new text");
    swap(true, "Du har ingen varer som kan bestilles ennå. Legg inn varer eller hent dem fra nettsiden din.",
      "Du har 0 varer som kan bestilles", pageSrc, "p3-02: the Bestillinger check (zero case) has the new text, not «0 varer»");
    ok(pageSrc.includes("Du har ${n} ${n === 1 ? \"vare\" : \"varer\"} som kan bestilles."), "p3-03: the count case (N > 0) is unchanged");

    // ── 4–6. Varer ───────────────────────────────────────────────────────────
    const items = require("../services/owner-items-view") as typeof import("../services/owner-items-view");
    ok(items.OWNER_ITEMS_INVENTED_TEXT_NB.lineAdminConfirmed === "Bekreftet av Rett fra Bonden.", "p4-01: «Bekreftet av Rett fra Bonden.»");
    ok(items.OWNER_ITEMS_TEXT_NB.notHereIntro === "Alkohol, tjenester og overskrifter fra nettsiden din kan ikke bestilles her. Du trenger ikke gjøre noe med dem.",
      "p5-01: «Kan ikke bestilles her» intro has the new text");
    ok(items.OWNER_ITEMS_INVENTED_TEXT_NB.fieldErrors.net_weight_required === "Ferdigpakket vare: skriv inn nettovekten, for eksempel 250 g.",
      "p6-01: the net-weight error says «for eksempel»");
    const card = require("./owner-items-card") as typeof import("./owner-items-card");
    ok(card.ownerItemsAddErrorText(["net_weight_required"]).includes("for eksempel 250 g") && !card.ownerItemsAddErrorText(["net_weight_required"]).includes("f.eks."), "p6-02: the add-form error text uses the new string");

    // ── 7–8. «Mine ordrer» and the short order page ──────────────────────────
    const view = require("./owner-orders-view") as typeof import("./owner-orders-view");
    const base = { agentId: "ag-tpa", producerName: "Gård TPA", counts: { venter: 0, kommende: 0, avsluttet: 0 } as any, orders: [], openId: null, error: "" };
    const page = (o: Partial<Parameters<typeof view.renderOrdersPage>[0]>) => view.renderOrdersPage({ ...base, tab: "venter", done: "", ...o } as any);
    const banners: Array<[string, string, string]> = [
      ["confirmed", "Bestillingen er bekreftet.", "Ordren er bekreftet."],
      ["declined", "Bestillingen er avslått.", "Ordren er avslått."],
      ["completed", "Bestillingen er registrert som hentet.", "Ordren er registrert som hentet."],
      ["ready", "Bestillingen er oppdatert.", "Ordren er oppdatert."],
    ];
    for (const [done, nw, old] of banners) swap(true, nw, old, page({ done }), `p7-banner-${done}: «${nw}»`);
    swap(true, "Ingen bestillinger venter på svar.", "Ingen ordrer venter på svar.", page({ tab: "venter" }), "p7-empty-01: the empty «Venter på svar» list");
    swap(true, "Ingen avsluttede bestillinger ennå.", "Ingen avsluttede ordrer ennå.", page({ tab: "avsluttet" }), "p7-empty-02: the empty «Avsluttet» list");

    const order = {
      id: "ord-tpa-00000001", agent_id: "ag-tpa", producer_name: "Gård TPA", status: "confirmed", cancel_reason: null, completion_source: null,
      pickup_time: null, total_nok: null, created_at: "2026-11-09 10:00:00", updated_at: "2026-11-09 10:00:00",
      buyer_name: "Kari", buyer_email: null, buyer_phone: null, delivery_note: null, payment_mode: "at_pickup",
      items: [{ name_snapshot: "Egg", qty: 1, line_total: null }],
      timeline: [{ from_status: null, to_status: "pending", created_at: "2026-11-09 10:00:00" }, { from_status: "pending", to_status: "confirmed", created_at: "2026-11-09 10:05:00" }],
    } as any;
    process.env.ORDER_AUTOCOMPLETE_ENABLED = "1";
    const AUTO_NEW = "Du trenger ikke gjøre mer. Bestillingen avsluttes av seg selv etter henting.";
    const AUTO_OLD = "Ordren avsluttes av seg selv etter henting.";
    const tokenPage = view.renderTokenOrderPage(order, "/produsent/ordre/ctok_x/kompakt", "", "");
    swap(true, AUTO_NEW, AUTO_OLD, tokenPage, "p7-auto-01: the auto-close hint (row actions)");
    swap(true, AUTO_NEW, AUTO_OLD, view.renderTokenOrderPage(order, "/produsent/ordre/ctok_x/kompakt", "", "", undefined, true), "p7-auto-02: the auto-close hint (T12 component)");
    delete process.env.ORDER_AUTOCOMPLETE_ENABLED;

    swap(true, ">Se alle bestillingene dine</a>", "Se alle ordrene dine", tokenPage, "p8-01: «Se alle bestillingene dine»");
    swap(true, "Lenken er personlig for denne bestillingen. Ikke del den videre.", "personlig for denne ordren", tokenPage, "p8-02: «Lenken er personlig for denne bestillingen.»");
    swap(true, "Kunden betaler deg når varene hentes. Rett fra Bonden tar ikke betalt.", "Ingen betaling skjer via plattformen", tokenPage, "p8-03: the payment line");

    // ── 9. «Avslå – utsolgt» legend ──────────────────────────────────────────
    const NEW9 = "Kryss av varene som er utsolgt. De blir merket som utsolgt.";
    const OLD9 = "Utsolgt (settes til «ikke på lager»):";
    const viewSrc = src("routes/owner-orders-view.ts");
    const cartSrc = src("routes/marketplace-cart.ts");
    ok(viewSrc.split(NEW9).length - 1 === 2 && !viewSrc.includes(OLD9), "p9-01: «Mine ordrer» and the short page (both components) have the new legend");
    ok(cartSrc.includes(NEW9) && !cartSrc.includes(OLD9), "p9-02: the producer order page has the new legend");

    // ── F-b: no «← Eierportalen» under the owner shell ──────────────────────
    const shell = page({ ownerShellHtml: `<nav class="os-menu"><a href="/eier/ag-tpa/portal">Oversikt</a></nav>` });
    ok(!shell.includes("← Eierportalen") && shell.includes("<h1>Mine ordrer</h1>"), "fb-01: with the owner shell, «Mine ordrer» has no «← Eierportalen» link");
    ok(page({}).includes(`<a href="/eier/ag-tpa/portal">← Eierportalen</a>`), "fb-02: without the shell (no menu) the back link stays, so the page is not a dead end");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    for (const k of SAVED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerTekstpakkeATests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) { for (const f of r.failures) console.log("  - " + f); process.exit(1); }
  });
}
