/**
 * cart-service-second-line.test.ts — proves isProducerEligible() (and, by
 * extension, addCartItem()/submitCart()) treats verified_second_line=1
 * agents as NOT eligible for cart/checkout.
 *
 * Fix-up to dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel,
 * closing a code-review CHANGES-REQUESTED finding on 36580f2b: the second
 * (lower-bar) verification line is meant to unlock OUTREACH/CONTACT only —
 * "porten er senket for kontakt, ikke for overtakelse" (the dev-request's own
 * guardrail (d)). Before this fix-up, isProducerEligible() only checked
 * `verification_status = 'verified'` and `umbrella_type IS NULL`, so a
 * second-line-only producer (thin/absent about, no live site, one soft
 * corroborating source) was immediately eligible for real customer orders —
 * identical treatment to a full first-line-verified producer. This suite
 * pins the fix: verified_second_line=1 producers are excluded from cart
 * eligibility, while first-line-verified producers (verified_second_line
 * 0 or NULL) are completely unaffected (regression guard).
 *
 * Mirrors cart-service-supply-graph.test.ts's fixture idiom:
 *   - fresh in-memory better-sqlite3 DB, real prod schema via
 *     __initSchemaForTesting.
 *   - cart-service's module-local test DB pinned via __setCartTestDb
 *     (race-proof, does not touch the global __setDbForTesting singleton).
 *   - exported runCartServiceSecondLineTests({log}) -> TestSummary; wired
 *     into tests/test.ts.
 *     Standalone: npx tsx src/services/cart-service-second-line.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCartServiceSecondLineTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("./cart-service") as typeof import("./cart-service");

  const prevDb = (() => {
    try { return initMod.getDb(); } catch { return undefined; }
  })();

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);

    // ── Seed one first-line-verified producer (verified_second_line=0/NULL default) ──
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES ('agent-first-line', 'Gard Førstelinje', 'test agent', 'test', 'first@example.com', 'https://example.com', 'producer', 'key-first')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status) VALUES ('agent-first-line', 'verified')
    `).run();

    // ── Seed one second-line-only producer (verified_second_line=1) ──
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES ('agent-second-line', 'Gard Andrelinje', 'test agent', 'test', 'second@example.com', 'https://example.com', 'producer', 'key-second')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status, verified_second_line)
      VALUES ('agent-second-line', 'verified', 1)
    `).run();

    // ── Seed products for both ──
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source)
      VALUES ('prod-first-line', 'agent-first-line', 'Førstelinje-vare', 'forstelinje-vare', 30, 'kg', 'in_stock', 'enrichment')
    `).run();
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source)
      VALUES ('prod-second-line', 'agent-second-line', 'Andrelinje-vare', 'andrelinje-vare', 30, 'kg', 'in_stock', 'enrichment')
    `).run();

    // ═══════════ isProducerEligible ═══════════

    assertTrue(
      cartSvc.isProducerEligible("agent-first-line") === true,
      "isProducerEligible: first-line-verified producer (verified_second_line=0) IS eligible"
    );
    assertTrue(
      cartSvc.isProducerEligible("agent-second-line") === false,
      "isProducerEligible: second-line-only producer (verified_second_line=1) is NOT eligible"
    );

    // ═══════════ addCartItem ═══════════

    {
      const cart = cartSvc.createCart();
      const r = cartSvc.addCartItem(cart.cart_id, "prod-first-line", 1);
      assertTrue(r.success === true, "addCartItem: first-line-verified producer's product is addable");
    }

    {
      const cart = cartSvc.createCart();
      const r = cartSvc.addCartItem(cart.cart_id, "prod-second-line", 1);
      assertTrue(r.success === false, "addCartItem: second-line-only producer's product is REJECTED");
    }

    // ── Regression guard: an agent_knowledge row that omits verified_second_line
    // entirely (schema default 0, the column is NOT NULL so an explicit NULL
    // is not representable) behaves identically to an explicit 0 — the SQL's
    // `IS NULL OR = 0` covers both a defaulted-0 row and (defensively) any
    // future NULL representation. ──
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES ('agent-default-second-line', 'Gard Default', 'test agent', 'test', 'defaultx@example.com', 'https://example.com', 'producer', 'key-default')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status)
      VALUES ('agent-default-second-line', 'verified')
    `).run();
    assertTrue(
      cartSvc.isProducerEligible("agent-default-second-line") === true,
      "isProducerEligible: verified producer with verified_second_line left at its schema default (0) IS eligible"
    );
  } finally {
    cartSvc.__setCartTestDb(null);
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCartServiceSecondLineTests({ log: true });
  console.log(`\ncart-service-second-line: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
