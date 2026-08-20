// ─── Admin: POST /admin/agents/url-write ────────────────────────────────────
//
// dev-request 2026-08-01-rfb-agents-url-skrivespak. Sister route to
// admin-agents-contact-email-write.ts, same defect class, same discipline.
//
// ── Why this route has to exist ─────────────────────────────────────────────
// `agents.url` is the producer's homepage as the catalog serves it. Like
// `contact_email` before lokal#444, it was set ONLY by the registration INSERT
// (marketplace.ts) and updated NOWHERE in src/ — effectively write-once.
// `PUT /admin/knowledge` writes `agent_knowledge.website` and can only touch
// `description`/`categories` on the agents table, so a wrong `agents.url` was
// unfixable.
//
// Measured on the live catalog 2026-08-01 (1623 agents, all 971 shown
// homepages HTTP-probed):
//
//   * only 445 (45 %) show a real, live, OWN homepage
//   * 340 show a host SHARED with other agents — a directory/network listing
//     (facebook 82, bondensmarked 77, rekonorge 60, hanen 37 …), not the
//     producer's own site. Most answer HTTP 200, so a liveness check alone
//     never flags them.
//   * 87 show an own host that is down (the Hommelstad case: hommelstad.no
//     serves 503 while the real farm is hommelstad.com)
//   * 4 show `rettfrabonden.com` — our own site as the producer's homepage
//
// ── The claim-lock gap this route CLOSES (measured, not theoretical) ─────────
// The sibling contact-email route locks on `agents.claimed_at IS NOT NULL`,
// mirroring admin-contact-write-guard-retro-sweep. On 2026-08-01 the A0 batch
// found three agents (Farmors Marked Johannesen, Hommelstad Gård, Røhne
// Bryggerhus) with a VERIFIED row in `agent_claims` that the `claimed_at`
// check did not catch — the two sources diverge in production. The operator
// had to exclude them by hand.
//
// This route therefore treats an agent as owner-locked when EITHER holds:
//   (a) `agents.claimed_at IS NOT NULL`, or
//   (b) a row exists in `agent_claims` with `status = 'verified'`.
// Same-defect note for whoever hardens the older routes: contact-email-write,
// contact-write-guard-retro-sweep and applyAgentOrgNr all still use (a) alone.
//
// ── Write discipline (identical to the contact-email sibling) ───────────────
//   * dry-run by DEFAULT; `apply` must be an explicit truthy form
//   * owner lock (above) and `curated_fields` per-field lock, both re-read
//     from a FRESH snapshot inside each row's own transaction
//   * one agent_knowledge_audit row per change carrying the OLD value
//   * per-row transaction — one failure never aborts the batch
//
// ── Value rules ─────────────────────────────────────────────────────────────
//   * `url: null` CLEARS the homepage, stored as the EMPTY STRING because
//     `agents.url` is `TEXT NOT NULL` (database/init.ts) — exactly the
//     constraint the sibling route hit for contact_email. The API keeps `null`
//     as the caller-facing spelling.
//   * A non-null url must be http(s), have a host with a dot, and must NOT be
//     a platform-owned host. Writing `rettfrabonden.com` in as a PRODUCER's
//     homepage is one of the measured defects, so the route refuses to create
//     it — fail closed, both directions.
//   * Directory/aggregator hosts are REJECTED BY DEFAULT (that is the whole
//     point: those 340 rows are the cleanup target, not a valid destination).
//     `allow_directory_host: true` is an explicit per-call escape hatch for
//     the rare producer whose only real presence genuinely is a listing —
//     it must be stated, never inferred.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import {
  ENRICHMENT_WRITE_PAUSE_HTTP_STATUS,
  enrichmentWritePauseBlockForAgents,
} from "../services/enrichment-write-pause";

const router = Router();

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

/** Hard cap per call — mirrors the sibling route. */
export const URL_WRITE_MAX_ITEMS = 200;

/**
 * DB seam. The route resolves its database through this indirection so a test
 * can point ITS OWN calls at an in-memory database without pinning the shared
 * getDb() singleton — pinning that singleton races any concurrently-running
 * block that reads it across an await, which is what broke PR #444's
 * determinism gate. Production never calls the setter.
 */
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
export function __setUrlWriteDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function db_(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

/** Registrable-ish host of a URL, lowercased, `www.` stripped. "" when unparseable. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec((url || "").trim());
  if (!m) return "";
  // Strip URL userinfo (`user:pass@` / `user@`) before extracting the host —
  // a real client resolves the host as everything AFTER the last `@` in the
  // authority, ignoring userinfo. Without this, `https://evil.com@rettfrabonden.com/`
  // returned the literal string "evil.com@rettfrabonden.com", which bypassed
  // both isPlatformOwnedHost and isDirectoryHost below.
  const authority = m[1];
  const at = authority.lastIndexOf("@");
  const hostPart = at === -1 ? authority : authority.slice(at + 1);
  const h = hostPart.toLowerCase().replace(/:\d+$/, "");
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** Our own hosts — never a producer's homepage. */
export function isPlatformOwnedHost(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  if (h === "rettfrabonden.com" || h.endsWith(".rettfrabonden.com")) return true;
  if (h === "fly.dev" || h.endsWith(".fly.dev")) return true;
  return false;
}

/**
 * Directory / network / social hosts measured on the live catalog as standing
 * in for a producer's own site. Matched on the registrable host or a suffix of
 * it, so `visitbo.no` and `www.visitbo.no` both count while a producer domain
 * that merely CONTAINS one of these strings does not.
 */
export const DIRECTORY_HOSTS: readonly string[] = [
  "facebook.com", "instagram.com", "youtube.com", "yelp.com", "tripadvisor.com", "tripadvisor.no",
  "bondensmarked.no", "bondensmarkedtroms.no", "rekonorge.no", "hanen.no", "lokalmat.no",
  "visittelemark.no", "visitnorway.com", "visitbergen.com", "visitgreateroslo.com",
  "visitsorlandet.com", "visitbo.no", "mathallenoslo.no", "matrikevestfold.no", "gladmat.no",
  "ostelandet.no", "ivaldres.no", "godtlokalt.no", "rensmak.no", "siderlandet.no",
  "honninglandet.no", "proff.no", "debio.no", "google.com", "maps.google.com", "business.site",
];

export function isDirectoryHost(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return DIRECTORY_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

/** Conservative shape check: http(s), a host, and at least one dot in it. */
export function isUsableHomepageUrl(url: string): boolean {
  const v = (url || "").trim();
  if (v.length === 0 || v.length > 2048) return false;
  if (/\s/.test(v)) return false;
  if (!/^https?:\/\//i.test(v)) return false;
  const h = hostOf(v);
  return h.length > 0 && h.includes(".") && !h.startsWith(".") && !h.endsWith(".");
}

/**
 * True iff curated_fields locks the homepage. Accepts both spellings the
 * codebase uses for this value (`website` on agent_knowledge, `url` on
 * agents). Malformed/missing JSON is treated as unlocked — same defensive
 * parse as the sibling routes.
 */
export function isUrlCurated(curatedFieldsJson: string | null | undefined): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    const o = parsed as Record<string, unknown>;
    return !!(o["website"] || o["url"]);
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
  | "rejected_invalid_url"
  | "rejected_platform_host"
  | "rejected_directory_host"
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

interface LockSnapshot {
  claimed_at: string | null;
  url: string | null;
  curated_fields: string | null;
  verified_claims: number;
}

const LOCK_SNAPSHOT_SQL = `
  SELECT a.claimed_at AS claimed_at,
         a.url        AS url,
         k.curated_fields AS curated_fields,
         (SELECT COUNT(*) FROM agent_claims c
           WHERE c.agent_id = a.id AND c.status = 'verified') AS verified_claims
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
   WHERE a.id = ?`;

/** Owner lock: `claimed_at` OR a verified row in agent_claims (the gap this route closes). */
function isOwnerLocked(s: LockSnapshot): boolean {
  return !!s.claimed_at || (s.verified_claims ?? 0) > 0;
}

/**
 * Write ONE agent's url (or clear it). Re-reads both locks and the current
 * value from a FRESH snapshot immediately before writing, inside its own
 * transaction, and writes an agent_knowledge_audit row carrying the OLD value.
 *
 * NOTE the LEFT JOIN: `url` lives on `agents`; an agent may have no
 * agent_knowledge row at all, and an INNER JOIN would silently make such rows
 * unwritable — the same trap the sibling route documents.
 */
function applyUrl(
  agentId: string,
  newValue: string | null,
  reason: string,
  batchTag: string,
): { outcome: ItemOutcome; oldValue?: string | null; detail?: string } {
  const db = db_();
  try {
    const tx = db.transaction((): { outcome: ItemOutcome; oldValue?: string | null; detail?: string } => {
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(agentId) as LockSnapshot | undefined;
      if (!cur) return { outcome: "not_found" };
      if (isOwnerLocked(cur)) return { outcome: "skipped_claimed" };
      if (isUrlCurated(cur.curated_fields)) return { outcome: "skipped_curated" };

      // `agents.url` is TEXT NOT NULL — "cleared" is the empty string.
      const storedNew = newValue === null ? "" : newValue.trim();
      const currentValue = cur.url ?? "";
      if (currentValue === storedNew) return { outcome: "skipped_unchanged", oldValue: cur.url };

      db.prepare(`UPDATE agents SET url = ? WHERE id = ?`).run(storedNew, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'url', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.url, storedNew, `${batchTag}: ${reason}`);

      return { outcome: "written", oldValue: cur.url };
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
  // FIRST thing after auth, before ANY validation and before any write. The
  // 2026-08-20 incident happened because the pause lived only as prose in a
  // SKILL file; this call is what makes it impossible to write here while a
  // pause is live, regardless of which caller or which SKILL revision. It
  // fails CLOSED — a lookup that cannot answer blocks the write. Gates the
  // whole request (not per item) so a paused batch performs ZERO writes.
  {
    // `db_` (the thunk), not `db_()` — a resolver that throws must fail CLOSED
    // as a 423 rather than escape as a 500 (PR review finding 3, 2026-08-20).
    const pauseBlock = enrichmentWritePauseBlockForAgents(
      db_,
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

  const body = (req.body ?? {}) as { items?: unknown; apply?: unknown; allow_directory_host?: unknown };
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const allowDirectory = body.allow_directory_host === true;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    res.status(400).json({ error: "Body must contain a non-empty 'items' array of {agent_id, url, reason}" });
    return;
  }
  if (body.items.length > URL_WRITE_MAX_ITEMS) {
    res.status(400).json({ error: `Too many items (max ${URL_WRITE_MAX_ITEMS} per call)` });
    return;
  }

  const batchTag = `url-write-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const db = db_();
  const results: ResultItem[] = [];
  const seen = new Set<string>();

  for (const raw of body.items as unknown[]) {
    const it = (raw ?? {}) as { agent_id?: unknown; url?: unknown; reason?: unknown };
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

    // `url` must be explicitly present: a string, or null to clear. `undefined`
    // is a malformed item, never an inferred instruction to clear.
    let newValue: string | null;
    if (it.url === null) {
      newValue = null;
    } else if (typeof it.url === "string") {
      newValue = it.url.trim();
      if (newValue === "") {
        results.push({
          agent_id: agentId,
          outcome: "rejected_invalid_item",
          detail: "empty string is not a clear instruction — send url: null",
        });
        continue;
      }
    } else {
      results.push({ agent_id: agentId, outcome: "rejected_invalid_item", detail: "url must be a string or null" });
      continue;
    }

    if (!reason) {
      results.push({ agent_id: agentId, outcome: "rejected_missing_reason" });
      continue;
    }
    if (newValue !== null && !isUsableHomepageUrl(newValue)) {
      results.push({ agent_id: agentId, outcome: "rejected_invalid_url", new_value: newValue });
      continue;
    }
    if (newValue !== null && isPlatformOwnedHost(newValue)) {
      results.push({ agent_id: agentId, outcome: "rejected_platform_host", new_value: newValue });
      continue;
    }
    if (newValue !== null && !allowDirectory && isDirectoryHost(newValue)) {
      results.push({ agent_id: agentId, outcome: "rejected_directory_host", new_value: newValue });
      continue;
    }

    const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(agentId) as LockSnapshot | undefined;
    if (!cur) {
      results.push({ agent_id: agentId, outcome: "not_found" });
      continue;
    }
    if (isOwnerLocked(cur)) {
      results.push({ agent_id: agentId, outcome: "skipped_claimed", old_value: cur.url });
      continue;
    }
    if (isUrlCurated(cur.curated_fields)) {
      results.push({ agent_id: agentId, outcome: "skipped_curated", old_value: cur.url });
      continue;
    }
    if ((cur.url ?? "") === (newValue === null ? "" : newValue)) {
      results.push({ agent_id: agentId, outcome: "skipped_unchanged", old_value: cur.url });
      continue;
    }

    if (dryRun) {
      results.push({ agent_id: agentId, outcome: "would_write", old_value: cur.url, new_value: newValue });
      continue;
    }

    const w = applyUrl(agentId, newValue, reason, batchTag);
    results.push({
      agent_id: agentId,
      outcome: w.outcome,
      old_value: w.oldValue ?? cur.url,
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
    allow_directory_host: allowDirectory,
    scanned: (body.items as unknown[]).length,
    counts,
    results,
  });
});

export default router;
