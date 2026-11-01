// ─── Admin: POST /admin/test-claim-fixture ───────────────────────────────
//
// dev-request 2026-11-01-rfb-kravflyt-tal-eiere-fra-e-post, AC6 (Daniel's
// option A, 2026-11-01). ONE hidden, UNCLAIMED RFB profile «Kravtest (skjult)»
// so the owner-claim flow can be tested end to end in production: /selger?
// agent=<id> → «Dette er min butikk» → code to the farm's known address →
// /claim/verify (or /claim/resend), and the manual approval with the «Profilen
// til X er nå din» mail and the owner-portal login. The order fixture of POST
// /admin/test-producer (origin='test_fixture') already has an owner and is
// never touched here — not even when its id is given.
//
// The claim gates are NOT touched: POST /api/marketplace/agents/:id/claim,
// /claim/resend and /claim/verify, rules 1–4, the per-IP limiter, the platform
// hourly cap, the shared-address rule, the quarantine badge gate and the admin
// approval treat the fixture like any other profile. It passes them because
// its DATA is set here (agent_knowledge.email = farm_email — rule 1's farm
// address — and no owner), never because a gate exempts it. The ONE
// visibility exception is GET /api/marketplace/agents/:id/info for the ARMED
// fixture (services/agent-visibility.ts, isArmedClaimTestFixtureRow): the
// lookup selger.html makes for /selger?agent=<id> and for the owner dashboard
// after the claim. Every list, search (incl. /find-match), feed, the sitemap,
// llms.txt, MCP/A2A, card/vcard/trust, /produsent/:slug and the as-public view
// keep it hidden (catalog_hidden = 1); the enrichment lanes that could write
// its e-mail skip catalog_hidden rows (catalogHiddenIdExclusionSql).
//
// Body: { apply?: true, mode?: "arm" | "retire", farm_email?: string, agent_id?: string }
//   * dry-run by DEFAULT — `apply` must be an explicit truthy form (same parse
//     as POST /admin/test-producer). Dry-run returns the plan + per-field
//     changes and writes nothing.
//   * mode "arm" (default) — requires `farm_email`, the address the claim code
//     will go to (a test inbox Daniel controls; same shape check as the
//     sibling's `email`, and it must be one address rule 1 accepts). Creates
//     the fixture when there is none; otherwise RESETS it to a fresh unclaimed
//     profile:
//       agents           is_active=1, is_verified=0, claimed_at=NULL, claimed_via=NULL
//       agent_knowledge  email=<farm_email>, data_source='auto'
//       agent_claims     every row of the fixture deleted (codes, queue
//                        entries and the claim tokens selger.html logs in with)
//       magic_links      every row of the fixture deleted (login links AND
//                        every owner session: the rfb_owner_session cookie,
//                        the /eier session and Bearer all read this table)
//       owner_profile_pause  the fixture's row deleted (a test owner's pause)
//       owner_order_email_change  a pending change superseded (as POST
//                        /admin/agents/:id/reset-claim does)
//   * mode "retire" — is_active=0; GET /info then 404s the fixture too. A
//     later "arm" re-arms (and resets) it. `farm_email` with retire → 400.
//
// Shared address: farm_email (normalized) must not already be the known farm
// e-mail of ANY other profile (KnowledgeService.knownEmailHoldersOtherThan —
// the rule isSharedKnownEmail applies at claim time), or every claim would go
// to the admin queue as `shared_address` instead of sending a code. Dry-run
// warns; apply refuses with 409 farm_email_shared and writes nothing.
//
// Which row (never more than ONE):
//   1. `agent_id` given → that row, which MUST already be the claim-test
//      fixture (origin='test_claim_fixture' AND catalog_hidden=1). Anything
//      else — the order fixture, any real producer — is refused with 409
//      not_a_claim_test_fixture and zero writes; an unknown id → 404.
//   2. no `agent_id` → the one claim-test fixture; none → a new one is created
//      (arm only; retire → 404); more than one → 409, nothing written.
//
// Every write below the guard is pinned to the fixture's id AND
// `origin='test_claim_fixture' AND catalog_hidden=1` in its OWN statement, so
// even a logic slip above cannot reach a real producer or the order fixture.
// One agent_knowledge_audit row per changed field (changed_by='admin'). The
// response never carries the full farm_email (maskEmail).
//
// Rollback: retire via this endpoint (or UPDATE agents SET is_active=0 WHERE
// origin='test_claim_fixture'); the row can stay.

import { Router, Request, Response } from "express";
import { randomUUID, randomBytes } from "crypto";
import { getDb } from "../database/init";
import { CLAIM_TEST_FIXTURE_ORIGIN, isClaimTestFixtureRow } from "../services/agent-visibility";
import { knowledgeService, isSingleEmailAddress } from "../services/knowledge-service";
import { normalizeEmail } from "../services/blocklist-service";
import { maskEmail } from "../services/gardssalg-claim";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { customerRuleSql } from "../services/customer-rule";

const router = Router();

// ── Injectable DB seam (tests only) — same convention as admin-test-producer.ts.
// The claim service (shared-address check, read-only claim_check) always reads
// getDb(); a test sets both to the same database.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setTestClaimFixtureDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

// Copied (not shared) — same convention as every sibling admin route.
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

export const CLAIM_FIXTURE_NAME = "Kravtest (skjult)";
const CLAIM_FIXTURE_DESCRIPTION = "Skjult testprofil for kravflyten (kun test — aldri offentlig).";
const CLAIM_FIXTURE_ABOUT = "Testprofil for Rett fra Bonden. Dette er ikke en ekte gård; profilen brukes til å teste eierkravet.";
/** Placeholder for the NOT NULL agents columns — never a real address or site. */
const CLAIM_FIXTURE_CONTACT = "kravtest@test-claim-fixture.invalid";
const CLAIM_FIXTURE_URL = "https://test-claim-fixture.invalid";
const EMAIL_SHAPE_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** SQL marker repeated in every fixture write's own statement. */
const MARKER = `origin = '${CLAIM_TEST_FIXTURE_ORIGIN}' AND catalog_hidden = 1`;
/** `<col> IN (the fixture, by id AND marker)` — bind the fixture id twice. */
const PINNED_AGENT = (col: string) => `${col} = ? AND ${col} IN (SELECT id FROM agents WHERE id = ? AND ${MARKER})`;

/**
 * Every write this route makes after the agents INSERT of a new fixture —
 * each pinned to the fixture's id AND the marker in its own statement.
 * Exported so the test runs each one directly with a real producer's id, the
 * order fixture's id and another claim fixture's id (it must change 0 rows).
 * Parameters in order:
 *   resetAgent [id] · deleteClaims / deleteMagicLinks / deletePause [id, id] ·
 *   supersedeOrderEmailChange [nowIso, id, id] · ensureKnowledge [id] ·
 *   setKnowledge [email, id, id] · retireAgent [id] · insertKnowledge [about, email, id]
 */
export const CLAIM_FIXTURE_WRITES = {
  resetAgent: `UPDATE agents SET is_active = 1, is_verified = 0, claimed_at = NULL, claimed_via = NULL WHERE id = ? AND ${MARKER}`,
  deleteClaims: `DELETE FROM agent_claims WHERE ${PINNED_AGENT("agent_id")}`,
  deleteMagicLinks: `DELETE FROM magic_links WHERE ${PINNED_AGENT("agent_id")}`,
  deletePause: `DELETE FROM owner_profile_pause WHERE ${PINNED_AGENT("agent_id")}`,
  supersedeOrderEmailChange:
    `UPDATE owner_order_email_change SET outcome = 'superseded', consumed_at = ?
      WHERE ${PINNED_AGENT("agent_id")} AND outcome IS NULL AND consumed_at IS NULL`,
  ensureKnowledge: `INSERT OR IGNORE INTO agent_knowledge (agent_id) SELECT id FROM agents WHERE id = ? AND ${MARKER}`,
  setKnowledge: `UPDATE agent_knowledge SET email = ?, data_source = 'auto' WHERE ${PINNED_AGENT("agent_id")}`,
  retireAgent: `UPDATE agents SET is_active = 0 WHERE id = ? AND ${MARKER}`,
  insertKnowledge: `INSERT INTO agent_knowledge (agent_id, about, email) SELECT id, ?, ? FROM agents WHERE id = ? AND ${MARKER}`,
} as const;
const W = CLAIM_FIXTURE_WRITES;

type Mode = "arm" | "retire";
type Target = "existing" | "create";

interface FixtureRow {
  id: string;
  origin: string | null;
  catalog_hidden: number | null;
  is_active: number | null;
  is_verified: number | null;
  claimed_at: string | null;
  claimed_via: string | null;
  has_knowledge: number;
  knowledge_email: string | null;
  data_source: string | null;
}

/** What a reset deletes or closes, counted for the plan. */
interface Artefacts {
  claims: number;
  magicLinks: number;
  pause: number;
  pendingOrderEmailChange: number;
}

interface Change {
  field: string;
  old: string | null;
  new: string | null;
}

function readRow(db: ReturnType<typeof getDb>, id: string): FixtureRow | undefined {
  return db
    .prepare(
      `SELECT a.id, a.origin, a.catalog_hidden, a.is_active, a.is_verified, a.claimed_at, a.claimed_via,
              CASE WHEN k.agent_id IS NULL THEN 0 ELSE 1 END AS has_knowledge,
              k.email AS knowledge_email, k.data_source
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(id) as FixtureRow | undefined;
}

/** Counts a table's rows for the agent; 0 when the table does not exist. */
function countFor(db: ReturnType<typeof getDb>, sql: string, id: string): number {
  try {
    return Number((db.prepare(sql).get(id) as { n: number } | undefined)?.n ?? 0);
  } catch {
    return 0;
  }
}

function readArtefacts(db: ReturnType<typeof getDb>, id: string): Artefacts {
  return {
    claims: countFor(db, "SELECT COUNT(*) AS n FROM agent_claims WHERE agent_id = ?", id),
    magicLinks: countFor(db, "SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = ?", id),
    pause: countFor(db, "SELECT COUNT(*) AS n FROM owner_profile_pause WHERE agent_id = ?", id),
    pendingOrderEmailChange: countFor(
      db,
      "SELECT COUNT(*) AS n FROM owner_order_email_change WHERE agent_id = ? AND outcome IS NULL AND consumed_at IS NULL",
      id,
    ),
  };
}

const NO_ARTEFACTS: Artefacts = { claims: 0, magicLinks: 0, pause: 0, pendingOrderEmailChange: 0 };

type Resolution =
  | { ok: true; target: Target; row: FixtureRow | undefined }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Picks the ONE row this call may touch, or refuses. Read-only. */
function resolveTarget(db: ReturnType<typeof getDb>, agentId: string | undefined, mode: Mode): Resolution {
  if (agentId !== undefined) {
    const row = readRow(db, agentId);
    if (!row) return { ok: false, status: 404, body: { error: "agent_not_found", agent_id: agentId } };
    if (isClaimTestFixtureRow(row)) return { ok: true, target: "existing", row };
    return {
      ok: false,
      status: 409,
      body: {
        error: "not_a_claim_test_fixture",
        agent_id: agentId,
        detail: `Endepunktet skriver kun til raden med origin='${CLAIM_TEST_FIXTURE_ORIGIN}' AND catalog_hidden=1 — ingenting er endret.`,
      },
    };
  }

  const fixtures = db
    .prepare(`SELECT id FROM agents WHERE ${MARKER} ORDER BY created_at, id`)
    .all() as Array<{ id: string }>;
  if (fixtures.length > 1) {
    return {
      ok: false,
      status: 409,
      body: { error: "multiple_claim_test_fixtures", ids: fixtures.map((f) => f.id), detail: "Oppgi agent_id — ingenting er endret." },
    };
  }
  if (fixtures.length === 1) return { ok: true, target: "existing", row: readRow(db, fixtures[0].id) };
  if (mode === "retire") {
    return { ok: false, status: 404, body: { error: "no_claim_test_fixture", detail: "Ingen kravtest-rad å retirere." } };
  }
  return { ok: true, target: "create", row: undefined };
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

const EMAIL_FIELD = "agent_knowledge.email";

/** Per-field changes this call makes (or would make). Pure. Values are real (the audit keeps them); the response masks the e-mail. */
function planChanges(target: Target, mode: Mode, row: FixtureRow | undefined, artefacts: Artefacts, farmEmail: string | null): Change[] {
  const changes: Change[] = [];
  const push = (field: string, oldV: unknown, newV: unknown) => {
    if (str(oldV) !== str(newV)) changes.push({ field, old: str(oldV), new: str(newV) });
  };
  if (target === "create") {
    push("agents.row", null, "created");
    push("origin", null, CLAIM_TEST_FIXTURE_ORIGIN);
    push("catalog_hidden", null, 1);
  }
  if (mode === "arm") {
    push("is_active", row?.is_active ?? null, 1);
    push("is_verified", row?.is_verified ?? null, 0);
    if (row) {
      push("claimed_at", row.claimed_at, null);
      push("claimed_via", row.claimed_via, null);
    }
    push(EMAIL_FIELD, row?.knowledge_email ?? null, farmEmail);
    if (row?.has_knowledge) push("agent_knowledge.data_source", row.data_source, "auto");
    if (artefacts.claims > 0) push("agent_claims", artefacts.claims, 0);
    if (artefacts.magicLinks > 0) push("magic_links", artefacts.magicLinks, 0);
    if (artefacts.pause > 0) push("owner_profile_pause", artefacts.pause, 0);
    if (artefacts.pendingOrderEmailChange > 0) push("owner_order_email_change.pending", artefacts.pendingOrderEmailChange, 0);
  } else {
    push("is_active", row?.is_active ?? null, 0);
  }
  return changes;
}

/** The changes as the response shows them: the e-mail field masked. */
function maskedChanges(changes: Change[]): Change[] {
  return changes.map((c) =>
    c.field === EMAIL_FIELD ? { field: c.field, old: c.old === null ? null : maskEmail(c.old), new: c.new === null ? null : maskEmail(c.new) } : c,
  );
}

class FixtureGuardError extends Error {}

/** A pinned write that must touch exactly one row. */
function runOne(db: ReturnType<typeof getDb>, sql: string, ...params: unknown[]): void {
  if (db.prepare(sql).run(...params).changes !== 1) throw new FixtureGuardError("fixture pin matched no row");
}

/**
 * Applies the plan in ONE transaction and returns the fixture id + the changes
 * actually made (re-planned from a fresh read inside the transaction, so the
 * audit rows match what was written). Throws on any guard miss — nothing is
 * committed then.
 */
function applyPlan(
  db: ReturnType<typeof getDb>,
  target: Target,
  mode: Mode,
  existingId: string | undefined,
  farmEmail: string | null,
): { id: string; changes: Change[] } {
  const tx = db.transaction((): { id: string; changes: Change[] } => {
    const fresh = existingId ? readRow(db, existingId) : undefined;
    if (target === "existing" && !isClaimTestFixtureRow(fresh)) throw new FixtureGuardError("row is no longer the claim-test fixture");
    const changes = planChanges(target, mode, fresh, fresh ? readArtefacts(db, fresh.id) : NO_ARTEFACTS, farmEmail);
    let id = existingId ?? "";
    if (target === "create") {
      id = randomUUID();
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                             categories, is_active, is_verified, origin, is_vetted, catalog_hidden)
         VALUES (?, ?, ?, ?, ?, ?, 'producer', ?, '[]', 1, 0, ?, 1, 1)`,
      ).run(
        id,
        CLAIM_FIXTURE_NAME,
        CLAIM_FIXTURE_DESCRIPTION,
        CLAIM_TEST_FIXTURE_ORIGIN,
        CLAIM_FIXTURE_CONTACT,
        CLAIM_FIXTURE_URL,
        `claimfixture_${randomBytes(16).toString("hex")}`,
        CLAIM_TEST_FIXTURE_ORIGIN,
      );
      runOne(db, W.insertKnowledge, CLAIM_FIXTURE_ABOUT, farmEmail, id);
    } else if (mode === "arm") {
      // Reset to a fresh unclaimed profile — every statement pinned to the
      // fixture's id AND marker (CLAIM_FIXTURE_WRITES).
      runOne(db, W.resetAgent, id);
      db.prepare(W.deleteClaims).run(id, id);
      db.prepare(W.deleteMagicLinks).run(id, id);
      try {
        db.prepare(W.deletePause).run(id, id);
      } catch { /* table missing — no pause to clear */ }
      try {
        db.prepare(W.supersedeOrderEmailChange).run(new Date().toISOString(), id, id);
      } catch { /* table missing — nothing pending */ }
      db.prepare(W.ensureKnowledge).run(id);
      runOne(db, W.setKnowledge, farmEmail, id, id);
    } else {
      runOne(db, W.retireAgent, id);
    }

    const audit = db.prepare(
      `INSERT INTO agent_knowledge_audit
         (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, 'admin', NULL, datetime('now'), ?)`,
    );
    for (const c of changes) {
      audit.run(randomUUID(), id, c.field, c.old, c.new, `admin/test-claim-fixture ${mode} (${target})`);
    }
    return { id, changes };
  });
  return tx();
}

function isValidEmailShape(v: string): boolean {
  return !!v && v.length <= 254 && EMAIL_SHAPE_RE.test(v) && !/[\x00-\x1f\x7f]/.test(v);
}

function parseApply(req: Request): boolean {
  const v = (req.body ?? {}).apply;
  return (
    v === true || v === 1 || v === "1" || v === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true"
  );
}

/** The other profiles whose known farm e-mail is `farmEmail` (read-only; at most 5 ids shown). */
function sharedWith(farmEmail: string, fixtureId: string | undefined): string[] {
  return knowledgeService.knownEmailHoldersOtherThan(farmEmail, fixtureId ?? "");
}

const SHARED_DETAIL =
  "farm_email er allerede kjent e-post på en annen profil. Krav på kravtest-profilen ville da gått til manuell godkjenning " +
  "som «delt adresse» i stedet for å sende kode. Bruk en testinnboks som ikke står på noen annen profil.";

/**
 * Read-only view of what the claim flow will make of the fixture now: whether
 * GET /info serves it, whether it has an owner (customerRuleSql — rule 3),
 * where rule 1 sends a code (masked) and whether that address is shared.
 */
function claimCheck(id: string) {
  const db = getDb();
  const owned = db.prepare(`SELECT ${customerRuleSql("a")} AS owned FROM agents a WHERE a.id = ?`).get(id) as { owned?: number } | undefined;
  const recipient = knowledgeService.resolveFarmContactEmail(id);
  return {
    info_served: !marketplaceRegistry.isQuarantinedFromPublicView(id, { claimTestFixtureInfo: true }),
    has_owner: !!owned && owned.owned === 1,
    code_recipient: recipient ? maskEmail(recipient) : null,
    shared_address: recipient ? knowledgeService.isSharedKnownEmail(recipient, id) : false,
  };
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body ?? {}) as { mode?: unknown; farm_email?: unknown; agent_id?: unknown };
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
  // The fixture guard runs FIRST, so a probe against a real producer id (or
  // the order fixture) is refused as not_a_claim_test_fixture regardless of
  // the rest of the body.
  const resolved = resolveTarget(db, agentId, mode);
  if (!resolved.ok) {
    res.status(resolved.status).json({ success: false, dry_run: !apply, ...resolved.body });
    return;
  }

  let farmEmail: string | null = null;
  if (mode === "arm") {
    const raw = typeof body.farm_email === "string" ? body.farm_email.trim() : "";
    farmEmail = normalizeEmail(raw);
    // The sibling's shape check, and one address rule 1 accepts as the farm's.
    if (!isValidEmailShape(raw) || !isSingleEmailAddress(farmEmail)) {
      res.status(400).json({ error: "mode 'arm' krever en gyldig { farm_email } (adressen kravkoden sendes til)" });
      return;
    }
  } else if (body.farm_email !== undefined) {
    res.status(400).json({ error: "farm_email er bare gyldig med mode 'arm'" });
    return;
  }

  const { target, row } = resolved;
  const shared = farmEmail !== null ? sharedWith(farmEmail, row?.id) : [];
  const sharedWarning = shared.length > 0
    ? { code: "farm_email_shared", detail: SHARED_DETAIL, other_profiles: shared.length, ids: shared.slice(0, 5) }
    : null;
  const selgerPath = (id: string) => `/selger?agent=${id}`;

  if (!apply) {
    const changes = planChanges(target, mode, row, row ? readArtefacts(db, row.id) : NO_ARTEFACTS, farmEmail);
    res.json({
      success: true,
      dry_run: true,
      mode,
      target,
      agent_id: row?.id ?? null,
      ...(row ? { selger_path: selgerPath(row.id) } : {}),
      ...(farmEmail !== null ? { farm_email: maskEmail(farmEmail) } : {}),
      changes: maskedChanges(changes),
      warnings: sharedWarning ? [sharedWarning] : [],
    });
    return;
  }

  if (sharedWarning) {
    res.status(409).json({
      success: false,
      dry_run: false,
      error: "farm_email_shared",
      detail: `${SHARED_DETAIL} Ingenting er endret.`,
      other_profiles: sharedWarning.other_profiles,
      ids: sharedWarning.ids,
    });
    return;
  }

  let id: string;
  let changes: Change[];
  try {
    ({ id, changes } = applyPlan(db, target, mode, row?.id, farmEmail));
  } catch (e: any) {
    const guard = e instanceof FixtureGuardError;
    res.status(guard ? 409 : 500).json({ success: false, dry_run: false, error: guard ? "fixture_guard_refused" : "write_failed", detail: e?.message ?? String(e) });
    return;
  }

  res.json({
    success: true,
    dry_run: false,
    mode,
    target,
    agent_id: id,
    selger_path: selgerPath(id),
    ...(farmEmail !== null ? { farm_email: maskEmail(farmEmail) } : {}),
    changes: maskedChanges(changes),
    audit_rows: changes.length,
    claim_check: claimCheck(id),
  });
});

export default router;
