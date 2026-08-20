// ─── Admin: POST /admin/agents/contact-email-write ──────────────────────────
//
// dev-request 2026-08-01-rfb-contact-email-skrivespak (slookisen/A2A), P0.
//
// ── Why this route has to exist ─────────────────────────────────────────────
// `agents.contact_email` is the column outreach actually SENDS TO — the CRM
// join in GET /admin/agents/dump matches `LOWER(c.email) = LOWER(a.contact_email)`
// (marketplace.ts). Until this route, that column was set ONLY by the INSERT in
// the registration path (marketplace.ts) and never updated anywhere in src/ —
// effectively write-once. That left two measured defects unfixable in prod
// (2026-08-01, 1623 agents):
//
//   * 77 agents carry OUR OWN address as the producer's contact
//     (kontakt@/info@/enrichment-agent@/enrichment-needed@rettfrabonden.com,
//     *@lokal.fly.dev) — 36 of them already `contacted_at`-stamped, i.e.
//     outreach had already been sent to our own inbox.
//   * 202 agents have an email domain with no DNS at all.
//
// ── The trap this route exists to avoid ─────────────────────────────────────
// PUT /admin/knowledge {agent_id, email} writes `agent_knowledge.email`, a
// DIFFERENT column, and answers {"success":true,"columns_updated":["email"]}
// while `agents.contact_email` stays untouched (pilot-proven on a test row,
// 2026-08-01). Callers cleaning up outreach addresses MUST use this route;
// a green response from the knowledge PUT does not mean outreach changed.
//
// ── Write discipline (identical to admin-contact-write-guard-retro-sweep) ───
//   * dry-run by DEFAULT. `apply` must be an explicit truthy form. A dry-run's
//     `written` is always 0 by construction — read `would_write` for "what
//     would happen".
//   * Row-level lock: `agents.claimed_at IS NOT NULL` is never written to. The
//     owner controls their own data from the moment they claim it.
//   * Per-field lock: `agent_knowledge.curated_fields` keyed "contact_email"
//     or "email" — either spelling locks this field (the codebase uses "email"
//     for the knowledge column; "contact_email" is accepted so a future
//     curator can lock this column by its own name).
//   * Both locks are re-read from a FRESH snapshot immediately before the
//     write, inside that write's own transaction — a row locked between scan
//     and write is left alone.
//   * One agent_knowledge_audit row per change, carrying the OLD value, so any
//     batch is reversible.
//   * Every write is scoped to ONE row and wrapped in its own transaction — a
//     failure on one row never aborts the batch or half-writes another.
//
// ── Value rules ─────────────────────────────────────────────────────────────
//   * `email: null` CLEARS the contact. This is the whole point of the cleanup
//     half, so it is explicitly legal — but it still requires a `reason`.
//
//     IMPLEMENTATION NOTE — cleared is stored as the EMPTY STRING, not SQL
//     NULL: `agents.contact_email` is declared `TEXT NOT NULL`
//     (database/init.ts), so a NULL write fails the constraint outright. The
//     empty string is the correct "no contact" representation here because the
//     outreach selector itself already treats the two as equivalent —
//     `AND a.contact_email IS NOT NULL AND a.contact_email != ''`
//     (marketplace.ts) — so a cleared row drops out of outreach exactly as a
//     NULL would have. The API keeps `null` as the caller-facing spelling
//     (callers should not have to know the storage detail) and the audit row
//     records the empty string that was actually written.
//   * A non-null email must be syntactically valid AND must not be a
//     platform-owned domain. Writing rettfrabonden.com / *.fly.dev in as a
//     PRODUCER's contact is precisely the defect being cleaned up, so the
//     route refuses to create it — fail closed, in both directions.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import {
  ENRICHMENT_WRITE_PAUSE_HTTP_STATUS,
  enrichmentWritePauseBlockForAgents,
} from "../services/enrichment-write-pause";

const router = Router();

// ── Injectable DB seam (tests only) ─────────────────────────────────────────
// tests/test.ts's "SHARED GLOBAL STATE" comment names the getDb() singleton as
// one of the three shared mutables that make the suite non-deterministic, and
// says outright: "Reach for an equivalent seam before reaching for a global."
// Pinning the singleton with __setDbForTesting() from this route's test block
// races every OTHER block that reads getDb() across an await — concretely, the
// orch-pr-86 block drives a real HTTP loopback whose handler resolves getDb()
// in a later event-loop turn, so a pin held here made it read the wrong DB and
// 404 on rows it had just inserted (observed on PR #444's determinism gate).
//
// So this route resolves its DB through one indirection that a test can
// override for ITS OWN calls, touching no global at all. Production code never
// calls the setter, so behavior outside tests is unchanged. Mirrors
// geocoding-service.ts's __setGeocodingFetchForTesting seam exactly.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setContactEmailWriteDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

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

/** Hard cap per call — mirrors the batch caps used by the other admin write routes. */
export const CONTACT_EMAIL_WRITE_MAX_ITEMS = 200;

/**
 * Domains that must never be stored as a PRODUCER's contact address. These are
 * the platform's own — an email here means outreach would mail ourselves.
 * Matched on the registrable host, case-insensitively; any `*.fly.dev`
 * subdomain counts (the measured defect included `tjamsland@lokal.fly.dev`).
 */
export function isPlatformOwnedEmailDomain(email: string): boolean {
  const dom = email.trim().toLowerCase().split("@")[1] ?? "";
  if (!dom) return false;
  if (dom === "rettfrabonden.com" || dom.endsWith(".rettfrabonden.com")) return true;
  if (dom === "fly.dev" || dom.endsWith(".fly.dev")) return true;
  return false;
}

/**
 * Conservative syntactic check. Deliberately NOT a full RFC 5322 parser: this
 * route only ever receives operator-supplied values, and the job here is to
 * reject the obviously-broken (no @, whitespace, missing TLD), not to litigate
 * exotic-but-legal addresses.
 */
export function isSyntacticallyValidEmail(email: string): boolean {
  const v = email.trim();
  if (v.length === 0 || v.length > 254) return false;
  if (/\s/.test(v)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(v);
}

/**
 * True iff the parsed curated_fields JSON locks this column. Tolerates
 * malformed/missing JSON (treated as "not locked") — same defensive-parse
 * convention as isContactFieldCurated (admin-contact-write-guard-retro-sweep).
 */
export function isContactEmailCurated(curatedFieldsJson: string | null | undefined): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    const o = parsed as Record<string, unknown>;
    return !!(o["contact_email"] || o["email"]);
  } catch {
    return false;
  }
}

type ItemOutcome =
  | "would_write"
  | "written"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "rejected_invalid_email"
  | "rejected_platform_domain"
  | "rejected_missing_reason"
  | "rejected_invalid_item"
  | "not_found"
  | "error";

interface ResultItem {
  agent_id: string;
  outcome: ItemOutcome;
  old_value?: string | null;
  new_value?: string | null;
  detail?: string;
}

/**
 * Write ONE agent's contact_email (or clear it). Re-reads claimed_at +
 * curated_fields + the current value from a FRESH snapshot immediately before
 * writing, inside its own transaction. Writes an agent_knowledge_audit row on
 * success carrying the OLD value, so the change is reversible.
 *
 * NOTE the LEFT JOIN: curated_fields lives on agent_knowledge, but an agent
 * may legitimately have no agent_knowledge row at all (contact_email lives on
 * `agents`). An INNER JOIN here would silently make such rows unwritable —
 * exactly the class of bug this route was created to fix.
 */
function applyContactEmail(
  db: ReturnType<typeof getDb>,
  agentId: string,
  newValue: string | null,
  reason: string,
  batchTag: string,
): { outcome: ItemOutcome; oldValue?: string | null; detail?: string } {
  try {
    const tx = db.transaction((): { outcome: ItemOutcome; oldValue?: string | null; detail?: string } => {
      const cur = db
        .prepare(
          `SELECT a.claimed_at AS claimed_at,
                  a.contact_email AS contact_email,
                  k.curated_fields AS curated_fields
             FROM agents a
             LEFT JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`,
        )
        .get(agentId) as
        | { claimed_at: string | null; contact_email: string | null; curated_fields: string | null }
        | undefined;

      if (!cur) return { outcome: "not_found" };
      if (cur.claimed_at) return { outcome: "skipped_claimed" };
      if (isContactEmailCurated(cur.curated_fields)) return { outcome: "skipped_curated" };

      // `contact_email` is TEXT NOT NULL — "cleared" is stored as "" (see the
      // header note). Compare on the same normalized form so a row already
      // holding "" is correctly reported unchanged rather than rewritten.
      const storedNew = newValue === null ? "" : newValue.trim();
      const currentValue = cur.contact_email ?? "";
      if (currentValue === storedNew) {
        return { outcome: "skipped_unchanged", oldValue: cur.contact_email };
      }

      db.prepare(`UPDATE agents SET contact_email = ? WHERE id = ?`).run(storedNew, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'contact_email', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.contact_email, storedNew, `${batchTag}: ${reason}`);

      return { outcome: "written", oldValue: currentValue };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
  // pause-mekanisk-gjerde) ───────────────────────────────────────────────────
  // FIRST thing after auth, before ANY validation and before any write — see
  // the sibling url-write route for the full rationale. Fails CLOSED; gates
  // the whole request so a paused batch performs ZERO writes.
  {
    // `resolveDb` (the thunk), not `resolveDb()` — a resolver that throws must
    // fail CLOSED as a 423, not escape as a 500 (PR review finding 3).
    const pauseBlock = enrichmentWritePauseBlockForAgents(
      resolveDb,
      (Array.isArray((req.body as any)?.items) ? ((req.body as any).items as unknown[]) : []).map((raw) => {
        const id = (raw as { agent_id?: unknown } | null)?.agent_id;
        return typeof id === "string" ? id : "";
      }),
    );
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  const body = (req.body ?? {}) as { items?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    res.status(400).json({ error: "Body must contain a non-empty 'items' array of {agent_id, email, reason}" });
    return;
  }
  if (body.items.length > CONTACT_EMAIL_WRITE_MAX_ITEMS) {
    res.status(400).json({ error: `Too many items (max ${CONTACT_EMAIL_WRITE_MAX_ITEMS} per call)` });
    return;
  }

  const batchTag = `contact-email-write-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const db = resolveDb();
  const results: ResultItem[] = [];
  const seen = new Set<string>();

  for (const raw of body.items as unknown[]) {
    const it = (raw ?? {}) as { agent_id?: unknown; email?: unknown; reason?: unknown };
    const agentId = typeof it.agent_id === "string" ? it.agent_id.trim() : "";
    const reason = typeof it.reason === "string" ? it.reason.trim() : "";

    if (!agentId) {
      results.push({ agent_id: "(missing)", outcome: "rejected_invalid_item", detail: "agent_id required" });
      continue;
    }
    if (seen.has(agentId)) {
      results.push({ agent_id: agentId, outcome: "rejected_invalid_item", detail: "duplicate_in_request" });
      continue;
    }
    seen.add(agentId);

    // `email` must be explicitly present: either a string, or null to clear.
    // `undefined` is a malformed item, not an instruction to clear — clearing
    // is destructive and must be stated, never inferred from an omission.
    let newValue: string | null;
    if (it.email === null) {
      newValue = null;
    } else if (typeof it.email === "string") {
      newValue = it.email.trim();
      if (newValue === "") {
        results.push({
          agent_id: agentId,
          outcome: "rejected_invalid_item",
          detail: "empty string is not a clear instruction — send email: null",
        });
        continue;
      }
    } else {
      results.push({ agent_id: agentId, outcome: "rejected_invalid_item", detail: "email must be a string or null" });
      continue;
    }

    if (!reason) {
      results.push({ agent_id: agentId, outcome: "rejected_missing_reason" });
      continue;
    }
    if (newValue !== null && !isSyntacticallyValidEmail(newValue)) {
      results.push({ agent_id: agentId, outcome: "rejected_invalid_email", new_value: newValue });
      continue;
    }
    if (newValue !== null && isPlatformOwnedEmailDomain(newValue)) {
      results.push({ agent_id: agentId, outcome: "rejected_platform_domain", new_value: newValue });
      continue;
    }

    const cur = db
      .prepare(
        `SELECT a.claimed_at AS claimed_at, a.contact_email AS contact_email, k.curated_fields AS curated_fields
           FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.id = ?`,
      )
      .get(agentId) as
      | { claimed_at: string | null; contact_email: string | null; curated_fields: string | null }
      | undefined;

    if (!cur) {
      results.push({ agent_id: agentId, outcome: "not_found" });
      continue;
    }
    if (cur.claimed_at) {
      results.push({ agent_id: agentId, outcome: "skipped_claimed", old_value: cur.contact_email });
      continue;
    }
    if (isContactEmailCurated(cur.curated_fields)) {
      results.push({ agent_id: agentId, outcome: "skipped_curated", old_value: cur.contact_email });
      continue;
    }
    if ((cur.contact_email ?? "") === (newValue === null ? "" : newValue)) {
      results.push({ agent_id: agentId, outcome: "skipped_unchanged", old_value: cur.contact_email });
      continue;
    }

    if (dryRun) {
      results.push({ agent_id: agentId, outcome: "would_write", old_value: cur.contact_email, new_value: newValue });
      continue;
    }

    const w = applyContactEmail(db, agentId, newValue, reason, batchTag);
    results.push({
      agent_id: agentId,
      outcome: w.outcome,
      old_value: w.oldValue ?? cur.contact_email,
      new_value: newValue,
      ...(w.detail ? { detail: w.detail } : {}),
    });
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned: (body.items as unknown[]).length,
    counts,
    results,
  });
});

export default router;
