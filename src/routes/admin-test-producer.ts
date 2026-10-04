// ─── Admin: POST /admin/test-producer ────────────────────────────────────
//
// dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt (Design 3–5).
// One hidden RFB test producer so Daniel can place REAL test orders through
// the full strict gate (cross-check + owner claim + opt-in + recipient)
// without SQL on the Fly volume and without the row being publicly visible.
// Same idea as opplevagent's POST /admin/gardssalg/test-provider, for `agents`.
//
// The trust gates are NOT touched: isProducerEligible(), isEligibleForRealOrder()
// (services/cart-service.ts) and resolveOrderNotificationRecipient()
// (services/order-notify-service.ts) stay byte-identical (pinned by a test).
// The fixture passes them because its DATA is set here, never because a gate
// exempts it.
//
// Body: { apply?: true, mode?: "arm" | "retire", email?: string, agent_id?: string }
//   * dry-run by DEFAULT — `apply` must be an explicit truthy form (same parse
//     as POST /admin/agents/deactivate). Dry-run returns the plan + per-field
//     changes and writes nothing.
//   * mode "arm" (default) — requires `email` (the order-notification
//     destination, i.e. Daniel's own inbox). Sets on the fixture row:
//     catalog_hidden=1, is_active=1, is_verified=1, order_notifications_opt_in=1,
//     order_notification_email=<email>; agent_knowledge.verification_status=
//     'verified', verified_second_line=0; and the product «Testpoteter (kun
//     test)» in_stock with a fresh availability timestamp (re-armed on every
//     call). is_verified=1 is written for the same reason as the cross-check
//     status: isEligibleForRealOrder() requires an owner-confirmed profile, and
//     a newly created fixture has no owner claim of its own (the legacy row
//     already carries Daniel's, so there it is a no-op).
//   * mode "retire" — is_active=0 and the product out_of_stock. A later "arm"
//     re-arms it (idempotent both ways).
//
// Which row (never more than ONE):
//   1. `agent_id` given → that row, which MUST already be a fixture
//      (origin='test_fixture' AND catalog_hidden=1). Anything else is refused
//      with 409 not_a_test_fixture and zero writes — this endpoint can never
//      verify, un-hide or touch a real producer. The single exception is the
//      hard-coded LEGACY_TEST_FIXTURE_ID below.
//   2. no `agent_id` → the one existing fixture row; if none exists, the legacy
//      pilot row «Test Gard Brreg» (dff0c55e…, which carries Daniel's owner
//      claim) is adopted (origin='test_fixture', catalog_hidden=1); if that is
//      gone too, a new fixture row is created (arm only). More than one fixture
//      row → 409, nothing written.
//
// Every write below the guard is pinned to `origin='test_fixture' AND
// catalog_hidden=1` in its OWN WHERE clause (adoption is pinned to the literal
// legacy id), so even a logic slip above cannot reach a real producer. One
// agent_knowledge_audit row per changed field (changed_by='admin').
//
// Rollback: retire via this endpoint (or UPDATE agents SET is_active=0 WHERE
// origin='test_fixture'); the catalog_hidden column is additive and can stay.

import { Router, Request, Response } from "express";
import { randomUUID, randomBytes } from "crypto";
import { getDb } from "../database/init";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { isEligibleForRealOrder } from "../services/cart-service";
import { invalidateSitemapCache } from "./seo";

const router = Router();

// ── Injectable DB seam (tests only) — same convention as admin-agents-deactivate.ts
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setTestProducerDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

// Copied (not shared) — same convention as every sibling admin-agents-* route.
function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

export const TEST_FIXTURE_ORIGIN = "test_fixture";
/** The 2026-10-01 pilot row «Test Gard Brreg» (owner-claimed by Daniel) — the only non-fixture row this route may adopt. */
export const LEGACY_TEST_FIXTURE_ID = "dff0c55e-8770-47cb-9e19-bd8099fcd5d5";
export const TEST_FIXTURE_PRODUCT_NAME = "Testpoteter (kun test)";
// Same normalisation as product-catalog-sync.ts's normalizeName(), so the
// upsert below converges on the row the daily catalog sync would create.
const TEST_FIXTURE_PRODUCT_NAME_NORM = TEST_FIXTURE_PRODUCT_NAME.toLowerCase().trim().replace(/\s+/g, " ");
const NEW_FIXTURE_NAME = "Testprodusent (kun test)";
const EMAIL_SHAPE_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** SQL pin repeated in every fixture write's own WHERE clause. */
function fixturePin(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return `${p}origin = '${TEST_FIXTURE_ORIGIN}' AND ${p}catalog_hidden = 1`;
}
const FIXTURE_PIN = fixturePin();

type Mode = "arm" | "retire";
type Target = "existing" | "adopt_legacy" | "create";

interface FixtureRow {
  id: string;
  name: string;
  origin: string | null;
  catalog_hidden: number | null;
  is_active: number | null;
  is_verified: number | null;
  umbrella_type: string | null;
  order_notifications_opt_in: number | null;
  order_notification_email: string | null;
  has_knowledge: number;
  verification_status: string | null;
  verified_second_line: number | null;
}

interface Change {
  field: string;
  old: string | null;
  new: string | null;
}

function readRow(db: ReturnType<typeof getDb>, id: string): FixtureRow | undefined {
  return db
    .prepare(
      `SELECT a.id, a.name, a.origin, a.catalog_hidden, a.is_active, a.is_verified, a.umbrella_type,
              a.order_notifications_opt_in, a.order_notification_email,
              CASE WHEN k.agent_id IS NULL THEN 0 ELSE 1 END AS has_knowledge,
              k.verification_status, k.verified_second_line
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(id) as FixtureRow | undefined;
}

export function isTestFixtureRow(row: { origin?: string | null; catalog_hidden?: number | null } | undefined): boolean {
  return !!row && row.origin === TEST_FIXTURE_ORIGIN && row.catalog_hidden === 1;
}

function readProduct(db: ReturnType<typeof getDb>, agentId: string): { id: string; availability: string } | undefined {
  return db
    .prepare(`SELECT id, availability FROM products WHERE agent_id = ? AND name_norm = ?`)
    .get(agentId, TEST_FIXTURE_PRODUCT_NAME_NORM) as { id: string; availability: string } | undefined;
}

type Resolution =
  | { ok: true; target: Target; row: FixtureRow | undefined }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Picks the ONE row this call may touch, or refuses. Read-only. */
function resolveTarget(db: ReturnType<typeof getDb>, agentId: string | undefined, mode: Mode): Resolution {
  if (agentId !== undefined) {
    const row = readRow(db, agentId);
    if (!row) return { ok: false, status: 404, body: { error: "agent_not_found", agent_id: agentId } };
    if (isTestFixtureRow(row)) return { ok: true, target: "existing", row };
    if (row.id === LEGACY_TEST_FIXTURE_ID && !row.umbrella_type) return { ok: true, target: "adopt_legacy", row };
    return {
      ok: false,
      status: 409,
      body: {
        error: "not_a_test_fixture",
        agent_id: agentId,
        detail: "Endepunktet skriver kun til raden med origin='test_fixture' AND catalog_hidden=1 — ingenting er endret.",
      },
    };
  }

  const fixtures = db
    .prepare(`SELECT id FROM agents WHERE ${FIXTURE_PIN} ORDER BY created_at, id`)
    .all() as Array<{ id: string }>;
  if (fixtures.length > 1) {
    return {
      ok: false,
      status: 409,
      body: { error: "multiple_test_fixtures", ids: fixtures.map((f) => f.id), detail: "Oppgi agent_id — ingenting er endret." },
    };
  }
  if (fixtures.length === 1) return { ok: true, target: "existing", row: readRow(db, fixtures[0].id) };

  const legacy = readRow(db, LEGACY_TEST_FIXTURE_ID);
  if (legacy && !legacy.umbrella_type) return { ok: true, target: "adopt_legacy", row: legacy };
  if (mode === "retire") return { ok: false, status: 404, body: { error: "no_test_fixture", detail: "Ingen fixture-rad å retirere." } };
  return { ok: true, target: "create", row: undefined };
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Per-field changes this call makes (or would make). Pure. */
function planChanges(
  target: Target,
  mode: Mode,
  row: FixtureRow | undefined,
  product: { availability: string } | undefined,
  email: string | null,
): Change[] {
  const changes: Change[] = [];
  const push = (field: string, oldV: unknown, newV: unknown) => {
    if (str(oldV) !== str(newV)) changes.push({ field, old: str(oldV), new: str(newV) });
  };
  if (target === "create") push("agents.row", null, "created");
  if (target === "create" || target === "adopt_legacy") {
    push("origin", row?.origin ?? null, TEST_FIXTURE_ORIGIN);
    push("catalog_hidden", row?.catalog_hidden ?? null, 1);
  }
  if (mode === "arm") {
    push("is_active", row?.is_active ?? null, 1);
    push("is_verified", row?.is_verified ?? null, 1);
    push("order_notifications_opt_in", row?.order_notifications_opt_in ?? null, 1);
    push("order_notification_email", row?.order_notification_email ?? null, email);
    push("verification_status", row?.verification_status ?? null, "verified");
    push("verified_second_line", row?.verified_second_line ?? null, 0);
    push(`product_availability:${TEST_FIXTURE_PRODUCT_NAME}`, product?.availability ?? null, "in_stock");
  } else {
    push("is_active", row?.is_active ?? null, 0);
    if (product) push(`product_availability:${TEST_FIXTURE_PRODUCT_NAME}`, product.availability, "out_of_stock");
  }
  return changes;
}

class FixtureGuardError extends Error {}

/**
 * Applies the plan in ONE transaction and returns the fixture id + the changes
 * actually made (re-planned from a fresh read inside the transaction, so the
 * audit rows match what was written even if the row moved since the dry-run
 * view). Throws on any guard miss — nothing is committed then.
 */
function applyPlan(
  db: ReturnType<typeof getDb>,
  target: Target,
  mode: Mode,
  existingId: string | undefined,
  email: string | null,
): { id: string; changes: Change[] } {
  const tx = db.transaction((): { id: string; changes: Change[] } => {
    const fresh = existingId ? readRow(db, existingId) : undefined;
    if (target === "existing" && !isTestFixtureRow(fresh)) throw new FixtureGuardError("row is no longer a test fixture");
    const changes = planChanges(target, mode, fresh, fresh ? readProduct(db, fresh.id) : undefined, email);
    let id = existingId ?? "";
    if (target === "create") {
      id = randomUUID();
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                             city, categories, is_active, is_verified, origin, is_vetted, catalog_hidden)
         VALUES (?, ?, ?, 'test_fixture', 'testprodusent@test-fixture.invalid', 'https://test-fixture.invalid',
                 'producer', ?, 'Oslo', '["vegetables"]', 1, 1, ?, 1, 1)`,
      ).run(
        id,
        NEW_FIXTURE_NAME,
        "Skjult testprodusent for ordreflyt-testing (kun test — aldri offentlig).",
        `fixture_${randomBytes(16).toString("hex")}`,
        TEST_FIXTURE_ORIGIN,
      );
      db.prepare(`INSERT INTO agent_knowledge (agent_id, about, products) VALUES (?, ?, ?)`).run(
        id,
        "Testprodusent for Rett fra Bonden. Dette er ikke en ekte gård; profilen brukes til å teste bestillingsflyten.",
        JSON.stringify([{ name: TEST_FIXTURE_PRODUCT_NAME, price: "30 kr/kg", category: "Grønnsaker" }]),
      );
    } else if (target === "adopt_legacy") {
      // Pinned to the literal legacy id — never any other row.
      const r = db
        .prepare(`UPDATE agents SET origin = ?, catalog_hidden = 1 WHERE id = ? AND id = ?`)
        .run(TEST_FIXTURE_ORIGIN, id, LEGACY_TEST_FIXTURE_ID);
      if (r.changes !== 1) throw new FixtureGuardError("legacy adoption matched no row");
    }

    if (mode === "arm") {
      const r = db
        .prepare(
          `UPDATE agents SET is_active = 1, is_verified = 1, order_notifications_opt_in = 1, order_notification_email = ?
            WHERE id = ? AND ${FIXTURE_PIN}`,
        )
        .run(email, id);
      if (r.changes !== 1) throw new FixtureGuardError("fixture pin matched no row");
      db.prepare(`INSERT OR IGNORE INTO agent_knowledge (agent_id) SELECT id FROM agents WHERE id = ? AND ${FIXTURE_PIN}`).run(id);
      db.prepare(
        `UPDATE agent_knowledge SET verification_status = 'verified', verified_second_line = 0
          WHERE agent_id = ? AND agent_id IN (SELECT id FROM agents WHERE ${FIXTURE_PIN})`,
      ).run(id);
      // Keep the product listed in agent_knowledge too, so lokal_info (by id)
      // shows it with its catalog product_id.
      const k = db.prepare(`SELECT products FROM agent_knowledge WHERE agent_id = ?`).get(id) as { products: string | null } | undefined;
      let products: any[] = [];
      try {
        const parsed = JSON.parse(k?.products || "[]");
        if (Array.isArray(parsed)) products = parsed;
      } catch { /* malformed → rewrite below */ }
      if (!products.some((p) => String(p?.name ?? "").trim().toLowerCase() === TEST_FIXTURE_PRODUCT_NAME_NORM)) {
        products.push({ name: TEST_FIXTURE_PRODUCT_NAME, price: "30 kr/kg", category: "Grønnsaker" });
        db.prepare(
          `UPDATE agent_knowledge SET products = ? WHERE agent_id = ? AND agent_id IN (SELECT id FROM agents WHERE ${FIXTURE_PIN})`,
        ).run(JSON.stringify(products), id);
      }
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, currency, availability, category,
                               source, availability_updated_at, created_at, updated_at)
         SELECT ?, a.id, ?, ?, 'kg', 30, 'NOK', 'in_stock', 'Grønnsaker', 'enrichment', ?, datetime('now'), datetime('now')
           FROM agents a WHERE a.id = ? AND ${fixturePin("a")}
         ON CONFLICT(agent_id, name_norm) DO UPDATE SET
           availability = 'in_stock',
           availability_updated_at = excluded.availability_updated_at,
           updated_at = datetime('now')`,
      ).run(randomUUID(), TEST_FIXTURE_PRODUCT_NAME, TEST_FIXTURE_PRODUCT_NAME_NORM, new Date().toISOString(), id);
    } else {
      const r = db.prepare(`UPDATE agents SET is_active = 0 WHERE id = ? AND ${FIXTURE_PIN}`).run(id);
      if (r.changes !== 1) throw new FixtureGuardError("fixture pin matched no row");
      db.prepare(
        `UPDATE products SET availability = 'out_of_stock', availability_updated_at = ?, updated_at = datetime('now')
          WHERE agent_id = ? AND name_norm = ? AND agent_id IN (SELECT id FROM agents WHERE ${FIXTURE_PIN})`,
      ).run(new Date().toISOString(), id, TEST_FIXTURE_PRODUCT_NAME_NORM);
    }

    const audit = db.prepare(
      `INSERT INTO agent_knowledge_audit
         (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, 'admin', NULL, datetime('now'), ?)`,
    );
    for (const c of changes) {
      audit.run(randomUUID(), id, c.field, c.old, c.new, `admin/test-producer ${mode} (${target})`);
    }
    return { id, changes };
  });
  return tx();
}

function parseApply(req: Request): boolean {
  const v = (req.body ?? {}).apply;
  return (
    v === true || v === 1 || v === "1" || v === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true"
  );
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body ?? {}) as { mode?: unknown; email?: unknown; agent_id?: unknown };
  const apply = parseApply(req);

  const mode: Mode | null = body.mode === undefined || body.mode === "arm" ? "arm" : body.mode === "retire" ? "retire" : null;
  if (!mode) {
    res.status(400).json({ error: "mode må være 'arm' (standard) eller 'retire'" });
    return;
  }
  if (body.agent_id !== undefined && (typeof body.agent_id !== "string" || !body.agent_id.trim())) {
    res.status(400).json({ error: "agent_id må være en ikke-tom streng" });
    return;
  }
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : undefined;

  const db = resolveDb();
  // The fixture guard runs FIRST, so a probe against a real producer id is
  // refused as not_a_test_fixture regardless of the rest of the body.
  const resolved = resolveTarget(db, agentId, mode);
  if (!resolved.ok) {
    res.status(resolved.status).json({ success: false, dry_run: !apply, ...resolved.body });
    return;
  }

  let email: string | null = null;
  if (mode === "arm") {
    email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email || email.length > 254 || !EMAIL_SHAPE_RE.test(email) || /[\x00-\x1f\x7f]/.test(email)) {
      res.status(400).json({ error: "mode 'arm' krever en gyldig { email } (mottaker for ordrevarselet)" });
      return;
    }
  }

  const { target, row } = resolved;

  if (!apply) {
    const changes = planChanges(target, mode, row, row ? readProduct(db, row.id) : undefined, email);
    res.json({ success: true, dry_run: true, mode, target, agent_id: row?.id ?? null, changes });
    return;
  }

  let id: string;
  let changes: Change[];
  try {
    ({ id, changes } = applyPlan(db, target, mode, row?.id, email));
  } catch (e: any) {
    const guard = e instanceof FixtureGuardError;
    res.status(guard ? 409 : 500).json({ success: false, dry_run: false, error: guard ? "fixture_guard_refused" : "write_failed", detail: e?.message ?? String(e) });
    return;
  }

  // The public list caches may still hold the legacy row from before adoption.
  marketplaceRegistry._agentsCache = null;
  marketplaceRegistry._statsCache = null;
  marketplaceRegistry._agentsCacheTime = 0;
  marketplaceRegistry._statsCacheTime = 0;
  invalidateSitemapCache();

  const after = readProduct(db, id);
  res.json({
    success: true,
    dry_run: false,
    mode,
    target,
    agent_id: id,
    changes,
    audit_rows: changes.length,
    product: after ? { id: after.id, name: TEST_FIXTURE_PRODUCT_NAME, availability: after.availability } : null,
    // Read-only evaluation of the UNCHANGED strict gate against the new state.
    can_order: isEligibleForRealOrder(id, db),
    products_url: `/api/marketplace/catalog/agents/${id}/products`,
  });
});

export default router;
