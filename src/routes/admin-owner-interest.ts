// ─── Admin: segment B («bekreftet, ikke eier») as a field ──────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-1.
//
// Segment B = a producer who answered positively in a customer-service thread
// (CS buckets B1/B2) but has NOT claimed the profile. Until now it lived only
// in the CS threads; this records it in agent_owner_interest (one row per
// marked agent, src/database/init.ts). Admin-only: no public surface,
// outreach, e-mail, MCP tool, owner portal or customerRuleSql() reads it.
//
//   POST /admin/agents/:id/owner-interest
//     body { interest: "confirmed_positive" | null, thread?: string (≤300),
//            dry_run?: boolean }   (zod, strict)
//     * "confirmed_positive" sets the row (owner_interest_at = now, ISO UTC);
//       null clears it. `thread` is only accepted together with a set.
//     * 404 unknown agent. Setting on an agent that already has a verified
//       owner (customerRuleSql: claimed_at set OR a verified agent_claims
//       row) → 409 { error: "already_owner" }. Clearing is always allowed.
//     * dry_run: true returns before/after and writes nothing.
//     * Each real write appends one agent_knowledge_audit row
//       (field_name 'owner_interest', changed_by 'admin', old/new = JSON).
//       Clearing an unmarked agent is a no-op (no write, no audit row).
//
//   GET /admin/owner-interest?limit=&offset=
//     Marked agents (id, name, slug, owner_interest, owner_interest_at,
//     owner_interest_thread, claimed_now). Parameterized SQL only.
//
// Rollback: stop calling the endpoints; the table is additive.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getDb } from "../database/init";
import { customerRuleSql } from "../services/customer-rule";
import { slugify } from "../utils/slug";

// ── Injectable DB seam (tests only) — same convention as
// admin-agents-deactivate.ts (__setAgentDeactivateDbForTesting).
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setOwnerInterestDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

// Copied (not shared) — same convention as every sibling admin route file
// (admin-agents-deactivate.ts, admin-cs-change-requests.ts …).
function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
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

export const OWNER_INTEREST_VALUES = ["confirmed_positive"] as const;
export const OWNER_INTEREST_THREAD_MAX = 300;

export const ownerInterestBodySchema = z
  .object({
    interest: z.enum(OWNER_INTEREST_VALUES).nullable(),
    thread: z.string().trim().min(1).max(OWNER_INTEREST_THREAD_MAX).optional(),
    dry_run: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.interest !== null || b.thread === undefined, {
    message: "thread is only accepted when setting interest",
    path: ["thread"],
  });

export interface OwnerInterestState {
  owner_interest: string | null;
  owner_interest_at: string | null;
  owner_interest_thread: string | null;
}

const EMPTY_STATE: OwnerInterestState = {
  owner_interest: null,
  owner_interest_at: null,
  owner_interest_thread: null,
};

interface Snapshot {
  exists: boolean;
  claimed: boolean;
  state: OwnerInterestState;
}

function readSnapshot(db: ReturnType<typeof getDb>, id: string): Snapshot {
  const row = db
    .prepare(
      `SELECT a.id AS id, ${customerRuleSql("a")} AS claimed,
              oi.owner_interest AS owner_interest,
              oi.owner_interest_at AS owner_interest_at,
              oi.owner_interest_thread AS owner_interest_thread
         FROM agents a
         LEFT JOIN agent_owner_interest oi ON oi.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(id) as
    | { id: string; claimed: number; owner_interest: string | null; owner_interest_at: string | null; owner_interest_thread: string | null }
    | undefined;
  if (!row) return { exists: false, claimed: false, state: { ...EMPTY_STATE } };
  return {
    exists: true,
    claimed: row.claimed === 1,
    state: {
      owner_interest: row.owner_interest ?? null,
      owner_interest_at: row.owner_interest_at ?? null,
      owner_interest_thread: row.owner_interest_thread ?? null,
    },
  };
}

// ── POST /admin/agents/:id/owner-interest ───────────────────────────────────
// Mounted at "/admin/agents/:id/owner-interest" (mergeParams), so the route is "/".
const agentRouter = Router({ mergeParams: true });

agentRouter.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
  if (!id || id.length > 200) {
    res.status(400).json({ error: "invalid agent id" });
    return;
  }
  const parsed = ownerInterestBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", details: parsed.error.issues });
    return;
  }
  const { interest, thread, dry_run } = parsed.data;
  const dryRun = dry_run === true;
  const db = resolveDb();

  try {
    const tx = db.transaction(() => {
      const snap = readSnapshot(db, id);
      if (!snap.exists) return { status: 404, body: { error: "Agent not found", agent_id: id } };
      if (interest !== null && snap.claimed) {
        return { status: 409, body: { error: "already_owner", agent_id: id } };
      }

      const before = snap.state;
      const after: OwnerInterestState =
        interest === null
          ? { ...EMPTY_STATE }
          : { owner_interest: interest, owner_interest_at: new Date().toISOString(), owner_interest_thread: thread ?? null };
      const changed = interest !== null || before.owner_interest !== null;

      if (dryRun || !changed) {
        return { status: 200, body: { agent_id: id, dry_run: dryRun, changed, claimed_now: snap.claimed, before, after } };
      }

      if (interest === null) {
        db.prepare(`DELETE FROM agent_owner_interest WHERE agent_id = ?`).run(id);
      } else {
        db.prepare(
          `INSERT INTO agent_owner_interest (agent_id, owner_interest, owner_interest_at, owner_interest_thread)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             owner_interest = excluded.owner_interest,
             owner_interest_at = excluded.owner_interest_at,
             owner_interest_thread = excluded.owner_interest_thread`,
        ).run(id, after.owner_interest, after.owner_interest_at, after.owner_interest_thread);
      }
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'owner_interest', ?, ?, 'admin', NULL, datetime('now'), ?)`,
      ).run(
        randomUUID(),
        id,
        before.owner_interest === null ? null : JSON.stringify(before),
        after.owner_interest === null ? null : JSON.stringify(after),
        interest === null ? "segment-b: cleared" : "segment-b: confirmed_positive (CS B1/B2)",
      );
      return { status: 200, body: { agent_id: id, dry_run: false, changed: true, claimed_now: snap.claimed, before, after } };
    });
    const out = tx();
    res.status(out.status).json(out.body);
  } catch (err: any) {
    res.status(500).json({ error: "owner-interest write failed" });
  }
});

// ── GET /admin/owner-interest?limit=&offset= ────────────────────────────────
// Mounted at "/admin/owner-interest", so the route is "/".
export const ownerInterestListRouter = Router();

function intParam(raw: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

ownerInterestListRouter.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const limit = intParam(req.query.limit, 100, 1, 500);
  const offset = intParam(req.query.offset, 0, 0, 1_000_000);
  try {
    const db = resolveDb();
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM agent_owner_interest`).get() as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT a.id AS id, a.name AS name,
                oi.owner_interest AS owner_interest,
                oi.owner_interest_at AS owner_interest_at,
                oi.owner_interest_thread AS owner_interest_thread,
                ${customerRuleSql("a")} AS claimed_now
           FROM agent_owner_interest oi
           JOIN agents a ON a.id = oi.agent_id
          ORDER BY oi.owner_interest_at DESC, a.id
          LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>;
    res.json({
      total,
      limit,
      offset,
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        // agents has no slug column: the /produsent/<slug> slug is derived
        // from the name by the canonical utils/slug.ts slugify().
        slug: slugify(String(r.name ?? "")),
        owner_interest: r.owner_interest,
        owner_interest_at: r.owner_interest_at,
        owner_interest_thread: r.owner_interest_thread,
        claimed_now: r.claimed_now === 1,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: "owner-interest list failed" });
  }
});

export default agentRouter;
