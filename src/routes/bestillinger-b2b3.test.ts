/**
 * bestillinger-b2b3.test.ts — dev-request 2026-10-28-rfb-bestillinger-fra-start-
 * til-slutt-for-eier, slice B2b-3 («myk utløp»: the owner-facing texts).
 *
 * With STOCK_SOFT_EXPIRY_ENABLED on AND the producer on the owner-features
 * allowlist, the owner's texts follow the soft rule; otherwise they are
 * byte-identical to before.
 *
 *   mail-*     renderStockCheckReminderEmail: flag off → the exact pre-B2b-3
 *              text (one and two items); flag on + allowlisted → the soft
 *              texts, the hard-stale day count from getSupplyGraphHardStaleDays();
 *              flag on, producer NOT allowlisted → the old text.
 *   banner-*   stockCheckBannerHtml: the same three cases.
 *   card-*     ownerOrderabilityCardHtml: the validity line and the per-row
 *              stock line (incl. a row already in the soft window).
 *   reg-*      «Mine valg» products.stock_check description per producer.
 *   cadence-*  soonExpiringItems selects the same rows with the rule on as off
 *              (a row 12 days old; a row 20 days old is never selected);
 *              STOCK_CHECK_WARN_DAYS 3, STOCK_CHECK_EMAIL_WINDOW_DAYS 14.
 *
 * Standalone: npx tsx src/routes/bestillinger-b2b3.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const DAY = 86_400_000;
const ENV_KEYS = [
  "STOCK_SOFT_EXPIRY_ENABLED", "SUPPLY_GRAPH_STALE_DAYS", "SUPPLY_GRAPH_HARD_STALE_DAYS",
  "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_FEATURES_ENFORCE",
];

const TP = "b2b3-test-producer"; // on the allowlist
const OTHER = "b2b3-other-producer"; // never on the allowlist

const OFF_ENV: NodeJS.ProcessEnv = { OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${TP}` };
const ON_ENV: NodeJS.ProcessEnv = { STOCK_SOFT_EXPIRY_ENABLED: "1", OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${TP}` };

// 10:00Z → the same calendar day in Oslo all year.
const EXP1 = "2026-11-05T10:00:00.000Z";
const EXP2 = "2026-11-06T10:00:00.000Z";
const LINK_EXP = "2026-11-12T10:00:00.000Z";
const CONFIRM_URL = "https://rettfrabonden.com/lagerstatus/s1.test.token";

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function runBestillingerB2b3Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }
  let cartSvc: typeof import("../services/cart-service") | null = null;

  try {
    for (const k of ENV_KEYS) delete process.env[k];
    // A non-default hard window proves the texts read the getter, not a literal 60.
    process.env.SUPPLY_GRAPH_HARD_STALE_DAYS = "45";
    const supply = require("../services/supply-graph") as typeof import("../services/supply-graph");
    const HARD = supply.getSupplyGraphHardStaleDays();
    assertEq(HARD, 45, "setup: getSupplyGraphHardStaleDays() follows SUPPLY_GRAPH_HARD_STALE_DAYS");

    const notify = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
    const portal = require("./owner-portal") as typeof import("./owner-portal");
    const registry = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const page = require("../owner-features/page") as typeof import("../owner-features/page");
    const sc = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");

    // ═══ mail-* ═════════════════════════════════════════════════════════════
    {
      const item = (id: string, name: string, exp: string) => ({ id, name, price_nok: 30, unit: "kg", expires_at: exp });
      const one = (agent: string) => ({ agent_id: agent, items: [item("p1", "Gulrøtter", EXP1)], confirm_url: CONFIRM_URL, link_expires_at: LINK_EXP });
      const two = (agent: string) => ({ ...one(agent), items: [item("p1", "Gulrøtter", EXP1), item("p2", "Kål & løk", EXP2)] });
      const appOf = (text: string) => (text.match(/logget inn: (\S+)\/eier\//) || [])[1] ?? "";

      // The pre-B2b-3 rendering, written out.
      const oldText = (lead: string, lines: string[], app: string, agent: string) =>
        `Hei,\n\n${lead}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\n` +
        "Når lagerstatusen har gått ut, kan kundene ikke bestille varen hos deg gjennom Rett fra Bonden før du har bekreftet den igjen.\n\n" +
        `Bekreft at varene fortsatt er på lager: ${CONFIRM_URL}\n\n` +
        "Lenken viser først hvilke varer som blir bekreftet. Ingenting endres før du trykker «Bekreft». Lenken gjelder til 12.11.2026.\n\n" +
        `Har du ikke varen lenger, kan du endre lagerstatusen når du er logget inn: ${app}/eier/${agent}/portal\n\n` +
        "Du får høyst én slik e-post hver 14. dag. Vil du ikke ha disse påminnelsene, svarer du på denne e-posten, så slår vi dem av.\n\nHilsen\nRett fra Bonden";
      const oldHtml = (lead: string, lis: string[], app: string, agent: string) =>
        `<p>Hei,</p>\n<p>${lead}</p>\n<ul>${lis.map((l) => `<li>${l}</li>`).join("")}</ul>\n` +
        "<p>Når lagerstatusen har gått ut, kan kundene ikke bestille varen hos deg gjennom Rett fra Bonden før du har bekreftet den igjen.</p>\n" +
        `<p><a href="${CONFIRM_URL}">Bekreft at varene fortsatt er på lager</a></p>\n` +
        "<p>Lenken viser først hvilke varer som blir bekreftet. Ingenting endres før du trykker «Bekreft». Lenken gjelder til 12.11.2026.</p>\n" +
        `<p>Har du ikke varen lenger, kan du endre lagerstatusen når du er logget inn: <a href="${app}/eier/${agent}/portal">${app}/eier/${agent}/portal</a></p>\n` +
        "<p>Du får høyst én slik e-post hver 14. dag. Vil du ikke ha disse påminnelsene, svarer du på denne e-posten, så slår vi dem av.</p>\n<p>Hilsen<br>Rett fra Bonden</p>";
      const LEAD1 = "Lagerstatusen for denne varen går snart ut:";
      const LEAD2 = "Lagerstatusen for 2 av varene dine går snart ut:";
      const L1 = "Gulrøtter (gjelder til 05.11.2026)";
      const L2 = "Kål & løk (gjelder til 06.11.2026)";
      const L2H = "Kål &amp; løk (gjelder til 06.11.2026)";

      const checkOld = (env: NodeJS.ProcessEnv, agent: string, tag: string) => {
        const r1 = notify.renderStockCheckReminderEmail(one(agent), env);
        const app = appOf(r1.textContent);
        assertTrue(/^https?:\/\//.test(app), `${tag}: the portal link is found`);
        assertEq(r1.subject, "Bekreft at varene fortsatt er på lager", `${tag}: subject (one item)`);
        assertEq(r1.textContent, oldText(LEAD1, [L1], app, agent), `${tag}: text byte-identical (one item)`);
        assertEq(r1.htmlContent, oldHtml(LEAD1, [L1], app, agent), `${tag}: html byte-identical (one item)`);
        const r2 = notify.renderStockCheckReminderEmail(two(agent), env);
        assertEq(r2.textContent, oldText(LEAD2, [L1, L2], app, agent), `${tag}: text byte-identical (two items)`);
        assertEq(r2.htmlContent, oldHtml(LEAD2, [L1, L2H], app, agent), `${tag}: html byte-identical (two items)`);
      };
      checkOld(OFF_ENV, TP, "mail-1 flag off");
      checkOld(ON_ENV, OTHER, "mail-2 flag on, producer not allowlisted");
      checkOld({ STOCK_SOFT_EXPIRY_ENABLED: "1" }, TP, "mail-3 flag on, empty allowlist");

      const s1 = notify.renderStockCheckReminderEmail(one(TP), ON_ENV);
      const s2 = notify.renderStockCheckReminderEmail(two(TP), ON_ENV);
      assertEq(s1.subject, "Bekreft at varene fortsatt er på lager", "mail-4: soft → subject unchanged");
      assertTrue(s1.textContent.includes("\n\nLagerstatusen for denne varen er snart ikke lenger bekreftet nylig:\n\n"), "mail-5: soft lead (one item)");
      assertTrue(s2.textContent.includes("\n\nLagerstatusen for 2 av varene dine er snart ikke lenger bekreftet nylig:\n\n"), "mail-6: soft lead (two items)");
      assertTrue(s2.textContent.includes("- Gulrøtter (bekreftet til 05.11.2026)\n- Kål & løk (bekreftet til 06.11.2026)"), "mail-7: soft item lines «bekreftet til»");
      assertTrue(!s2.textContent.includes("gjelder til 0") && !s2.htmlContent.includes("gjelder til 0"), "mail-8: soft → no item «gjelder til»");
      assertTrue(!s1.textContent.includes("går snart ut") && !s1.textContent.includes("Når lagerstatusen har gått ut"), "mail-9: soft → no old expiry text");
      const why = "Kundene kan fortsatt bestille varen, men fra denne datoen ser de at lagerstatusen ikke er bekreftet nylig. Når du bekrefter varen, fornyes datoen. " +
        `Har ingen bekreftet varen på ${HARD} dager, kan den ikke bestilles før du har bekreftet den igjen.`;
      assertTrue(s1.textContent.includes(`\n\n${why}\n\n`) && s1.htmlContent.includes(`<p>${why}</p>`), "mail-10: soft «why» with the hard-stale days from the getter");
      assertTrue(s1.textContent.includes("Har ingen bekreftet varen på 45 dager"), "mail-11: … 45 (env), not a literal 60");
      assertTrue(s1.textContent.includes("Du får høyst én slik e-post hver 14. dag.") && s1.textContent.includes(`: ${CONFIRM_URL}\n\n`)
        && s1.textContent.includes("Lenken gjelder til 12.11.2026.") && s1.textContent.includes("/eier/b2b3-test-producer/portal"),
        "mail-12: soft → link, how, portal link and the 14-day opt-out unchanged");
    }

    // ═══ banner-* ═══════════════════════════════════════════════════════════
    {
      const items = [{ id: "p1", name: "Gulrøtter", price_nok: 30, unit: "kg", expires_at: EXP1 }];
      const items2 = [...items, { id: "p2", name: "Kål", price_nok: 30, unit: "kg", expires_at: EXP2 }];
      const oldBanner = (agent: string, its: typeof items2, heading: string, para: string, meta: string) =>
        `<div class="ep-alert ep-alert-error" role="note" data-stock-check-banner="1">
          <strong>${heading}</strong>
          <p style="margin:6px 0;">${para}</p>
          <ul>${its.map((i) => `<li data-product-id="${i.id}">${i.name} <span class="ep-audit-meta">${meta} ${i.id === "p1" ? "05.11.2026" : "06.11.2026"}</span></li>`).join("")}</ul>
          <form method="post" action="/eier/${agent}/varer/bekreft-lagerpaminnelse" style="margin:8px 0 0;">
            ${its.map((i) => `<input type="hidden" name="id" value="${i.id}">`).join("")}
            <button type="submit" class="ep-btn ep-btn-primary">Bekreft at varene fortsatt er på lager</button>
          </form>
        </div>`;
      const OLD_H = "Lagerstatusen går snart ut";
      const oldP = (one: boolean) => `Når den har gått ut, kan kundene ikke bestille ${one ? "varen" : "varene"} før du har bekreftet ${one ? "den" : "dem"} igjen.`;
      assertEq(portal.stockCheckBannerHtml(TP, items, OFF_ENV), oldBanner(TP, items, OLD_H, oldP(true), "gjelder til"), "banner-1: flag off → byte-identical (one item)");
      assertEq(portal.stockCheckBannerHtml(TP, items2, OFF_ENV), oldBanner(TP, items2, OLD_H, oldP(false), "gjelder til"), "banner-2: flag off → byte-identical (two items)");
      assertEq(portal.stockCheckBannerHtml(OTHER, items2, ON_ENV), oldBanner(OTHER, items2, OLD_H, oldP(false), "gjelder til"), "banner-3: flag on, not allowlisted → byte-identical");
      assertEq(portal.stockCheckBannerHtml(TP, [], ON_ENV), "", "banner-4: no items → no banner");
      const SOFT_H = "Lagerstatusen er snart ikke lenger bekreftet nylig";
      const softP = (one: boolean) => `Kundene kan fortsatt bestille ${one ? "varen" : "varene"}, men de ser at lagerstatusen ikke er bekreftet nylig. Bekreft ${one ? "den" : "dem"} for å fornye datoen.`;
      assertEq(portal.stockCheckBannerHtml(TP, items, ON_ENV), oldBanner(TP, items, SOFT_H, softP(true), "bekreftet til"), "banner-5: soft (one item) → soft heading, text, «bekreftet til»");
      assertEq(portal.stockCheckBannerHtml(TP, items2, ON_ENV), oldBanner(TP, items2, SOFT_H, softP(false), "bekreftet til"), "banner-6: soft (two items)");
    }

    // ═══ card-* ═════════════════════════════════════════════════════════════
    {
      const base = { price_nok: 30, unit: "kg", availability: "in_stock", availability_source: "producer_dashboard", reasons: [], missing_price: false, confirmable: true };
      const overview = (withSoftRow: boolean) => ({
        products: [
          { ...base, id: "p1", name: "Gulrøtter", orderable: true, stock_expires_at: EXP1 },
          ...(withSoftRow ? [{ ...base, id: "p2", name: "Kål", orderable: true, stock_expires_at: "2026-10-25T10:00:00.000Z",
            stock_confirmed_at: "2026-10-11T10:00:00.000Z", needs_producer_confirmation: true as const }] : []),
        ],
        orderable_count: withSoftRow ? 2 : 1,
        profile_reasons: [],
      });
      const OLD_LINE = "kan bestilles nå. En bekreftelse på lager gjelder i 14 dager.</p>";
      const SOFT_LINE = `kan bestilles nå. En bekreftelse på lager gjelder i 14 dager. Etter det kan kundene fortsatt bestille i opptil ${HARD} dager, med datoen for siste bekreftelse synlig.</p>`;
      const off = portal.ownerOrderabilityCardHtml(TP, overview(false), "", OFF_ENV);
      assertTrue(off.includes(OLD_LINE) && !off.includes("Etter det"), "card-1: flag off → the old validity line");
      assertTrue(off.includes(`<strong class="ep-orderable-yes">Kan bestilles</strong> <span class="ep-audit-meta">Lagerstatus gjelder til 05.11.2026</span></div>`), "card-2: flag off → «Lagerstatus gjelder til»");
      assertEq(portal.ownerOrderabilityCardHtml(OTHER, overview(false), "", ON_ENV), portal.ownerOrderabilityCardHtml(OTHER, overview(false), "", OFF_ENV),
        "card-3: flag on, not allowlisted → byte-identical to flag off");
      assertEq(portal.ownerOrderabilityCardHtml(TP, overview(false), "", {}), off, "card-4: flag off, empty allowlist → byte-identical");
      const on = portal.ownerOrderabilityCardHtml(TP, overview(true), "", ON_ENV);
      assertTrue(on.includes(SOFT_LINE), "card-5: soft → validity line with the hard-stale days from the getter");
      assertTrue(on.includes(`<span class="ep-audit-meta">Lagerstatus bekreftet til 05.11.2026</span>`), "card-6: soft → «Lagerstatus bekreftet til»");
      assertTrue(on.includes(`<span class="ep-audit-meta" data-stock-soft="1">Lagerstatus sist bekreftet 11.10.2026. Kundene ser at den ikke er bekreftet nylig.</span>`),
        "card-7: soft-window row → last confirmed date, not «expired»");
      assertTrue(!on.includes("gjelder til") && !on.includes("25.10.2026"), "card-8: soft → no «gjelder til», the soft-window row's past 14-day date is not shown");
    }

    // ═══ reg-* ══════════════════════════════════════════════════════════════
    {
      const e = registry.getOwnerFeature("products.stock_check");
      const OLD_NO = "Vi sier fra før lagerstatusen på en vare går ut, slik at kundene fortsatt kan bestille den. Du får høyst én e-post hver 14. dag.";
      assertEq(e.description.no, OLD_NO, "reg-1: the registry entry's description is unchanged");
      assertEq(page.ownerRowDescription(TP, e, OFF_ENV).no, OLD_NO, "reg-2: flag off → the old description");
      assertEq(page.ownerRowDescription(OTHER, e, ON_ENV).no, OLD_NO, "reg-3: flag on, not allowlisted → the old description");
      assertEq(page.ownerRowDescription(TP, e, ON_ENV), {
        no: "Vi sier fra før lagerstatusen på en vare ikke lenger er bekreftet nylig. Da ser kundene datoen for siste bekreftelse. Du får høyst én e-post hver 14. dag.",
        en: "We let you know before the stock status of an item is no longer recently confirmed; customers then see the date it was last confirmed. You get at most one e-mail every 14 days.",
      }, "reg-4: soft → the soft description (no + en)");
      const other = registry.getOwnerFeature("orders.enabled");
      assertEq(page.ownerRowDescription(TP, other, ON_ENV), other.description, "reg-5: soft → other rows unchanged");
    }

    // ═══ cadence-* ══════════════════════════════════════════════════════════
    {
      assertEq([sc.STOCK_CHECK_WARN_DAYS, sc.STOCK_CHECK_EMAIL_WINDOW_DAYS], [3, 14], "cadence-1: warn 3 days before, at most one per 14 days");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
      cartSvc.__setCartTestDb(db as any);
      const T = new Date(`${new Date().toISOString().slice(0, 10)}T10:00:00Z`);
      const ago = (d: number) => sqlTs(new Date(T.getTime() - d * DAY));
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in)
         VALUES (?, 'B2b3 Gard', 'Testprodusent B2b-3.', 'test', ?, ?, 'producer', ?, 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
      ).run(TP, `post@${TP}.example.no`, `https://${TP}.example.no`, `key-${TP}`);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
         VALUES (?, ?, ?, 'Liten gård.', 'verified', 0)`,
      ).run(TP, `post@${TP}.example.no`, `https://${TP}.example.no`);
      const seed = (pid: string, name: string, days: number) => db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
         VALUES (?, ?, ?, ?, 30, 'kg', 'in_stock', 'vegetables', 'producer_dashboard', ?)`,
      ).run(pid, TP, name, name.toLowerCase(), ago(days));
      seed("c-12", "Gulrøtter", 12); // expires T + 2 d → selected
      seed("c-20", "Løk", 20);       // 14-day limit passed 6 days ago → never selected
      seed("c-1", "Kål", 1);         // expires T + 13 d → not yet

      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${TP}`;
      delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
      const off = sc.soonExpiringItems(TP, { db, now: T });
      process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";
      const on = sc.soonExpiringItems(TP, { db, now: T });
      assertEq(off.map((i) => i.id), ["c-12"], "cadence-2: rule off → the row 12 days old is selected");
      assertEq(on, off, "cadence-3: rule on → the same items selected (same expiry date)");
      const onLater = sc.soonExpiringItems(TP, { db, now: new Date(T.getTime() + 3 * DAY) });
      assertEq(onLater.map((i) => i.id), [], "cadence-4: rule on, after the 14-day limit → no longer selected (no extra reminders in the soft window)");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { cartSvc?.__setCartTestDb(null); } catch { /* ignore */ }
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBestillingerB2b3Tests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nbestillinger-b2b3: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
