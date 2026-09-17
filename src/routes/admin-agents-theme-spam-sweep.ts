// ─── Admin: POST /admin/agents/theme-spam-sweep ─────────────────────────────
//
// dev-request 2026-09-16-kaprede-produsentdomener-kasino-spam-i-beskrivelser.
// Daniel live 2026-09-17: «Fiks alle profiler som er kapret, og har fått
// kasino informasjon. Dem er ikke verifisert av eier.»
//
// ── The defect this cleans up ──────────────────────────────────────────────
// A producer's domain lapsed or was hijacked and now serves an online-casino
// affiliate site. It still answers HTTP 200, so every liveness check passes,
// and the homepage-content-refresh (admin-knowledge.ts) copied the casino
// site's meta description into `agent_knowledge.about` — from where it
// reached the public profile page (body AND <meta description>), GET
// /agents, llms-full.txt and the lokal_search answers AI agents relay. Live
// 2026-09-16: Mølleren Sylvia (mollerensylvia.no), Mosbøen Gård
// (mosboengaard.no), Valdres Vilt (valdresvilt.com), Halås Gårdsutsalg
// (halaas-gardsutsalg.com) — none of them owner-claimed.
//
// The write-time half of the fix lives elsewhere (looksLikeThemeSpam in
// description-quality.ts on every description/about door, and
// pageLooksLikeThemeSpam in search-enrich.ts refusing the page as a source);
// this route cleans rows written BEFORE those gates existed.
//
// ── What one hit does (per agent, one transaction) ─────────────────────────
//   1. `agents.description`     -> ''    when it reads as theme spam
//      `agent_knowledge.about`  -> NULL  when it reads as theme spam
//      (same value rules as the code-artifact sibling: description is TEXT
//      NOT NULL, about is nullable)
//   2. and ONLY when at least one text field was actually cleaned here, the
//      hijacked SOURCE is dropped too, so the daily refresh cannot fetch it
//      again and the profile stops linking to a casino:
//      `agent_knowledge.website` -> NULL, `agents.url` -> '' (TEXT NOT NULL).
//   3. contact e-mails whose domain IS that hijacked host are REPORTED as
//      warnings (mail there now reaches the squatter), never written — a
//      contact write has its own guard and is a separate decision.
//
// ── Write discipline (copied from admin-agents-description-code-artifact-
//    sweep.ts, which copied it from admin-agents-url-write.ts) ─────────────
//   * dry-run by DEFAULT; `apply` must be an explicit truthy form
//   * owner lock (claimed_at OR a verified agent_claims row) and
//     `curated_fields` per-field lock (description / about / website), both
//     re-read from a FRESH snapshot inside each row's own transaction
//   * one agent_knowledge_audit row per changed column carrying the OLD
//     value — the ROLLBACK RECIPE is the audit row itself
//   * per-row transaction — one failure never aborts the batch
//   * enrichment-write-pause gate on the candidate id set, before the
//     dry-run branch, fails CLOSED and blocks the whole request
//   * full-catalog SCAN; only the first THEME_SPAM_SWEEP_MAX_ITEMS (200)
//     candidates are processed per call; `candidates_considered` is the
//     full pre-cap count
//   * idempotent: a cleaned row is no longer a candidate on the next run
import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { looksLikeThemeSpam } from "../services/description-quality";
import { hostFromUrlLike } from "../services/cross-source-validator";
import {
  enrichmentWritePauseBlockForAgents,
  ENRICHMENT_WRITE_PAUSE_HTTP_STATUS,
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

/** Hard cap per call — mirrors the sibling sweeps' per-call cap. */
export const THEME_SPAM_SWEEP_MAX_ITEMS = 200;

/**
 * DB seam — same rationale as the sibling sweeps: a test points ITS OWN
 * calls at an in-memory database without pinning the shared getDb()
 * singleton. Production never calls the setter.
 */
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
export function __setThemeSpamSweepDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function db_(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

/** Truncated preview only — the full old value stays in the audit row. */
export function previewValue(s: string | null | undefined, maxLen = 80): string {
  const v = s ?? "";
  if (v.length <= maxLen) return v;
  return v.slice(0, maxLen) + "…";
}

export type ThemeSpamField = "description" | "about";
export type ThemeSpamFieldOutcome =
  | "would_write"
  | "written"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "error";
export type ThemeSpamSourceOutcome =
  | "would_clear"
  | "cleared"
  | "skipped_claimed"
  | "skipped_curated"
  | "none"
  | "error";

export interface ThemeSpamAgentResult {
  agent_id: string;
  name: string;
  /** Per matched text field. A field that did not read as spam is absent. */
  fields: Partial<Record<ThemeSpamField, ThemeSpamFieldOutcome>>;
  /** The hijacked source: agent_knowledge.website / agents.url. */
  website: ThemeSpamSourceOutcome;
  url: ThemeSpamSourceOutcome;
  website_host?: string | null;
  old_value_preview?: string;
  /** e.g. contact_email_on_hijacked_host:<email> — reported, never written. */
  warnings?: string[];
  detail?: string;
  outcome: "would_write" | "written" | "skipped_claimed" | "skipped_curated" | "skipped_unchanged" | "not_found" | "error";
}

interface Snapshot {
  id: string;
  name: string;
  description: string;
  url: string;
  contact_email: string | null;
  claimed_at: string | null;
  about: string | null;
  website: string | null;
  knowledge_email: string | null;
  curated_fields: string | null;
  verified_claims: number;
}

const SNAPSHOT_SELECT = `
  SELECT a.id            AS id,
         a.name          AS name,
         a.description   AS description,
         a.url           AS url,
         a.contact_email AS contact_email,
         a.claimed_at    AS claimed_at,
         k.about         AS about,
         k.website       AS website,
         k.email         AS knowledge_email,
         k.curated_fields AS curated_fields,
         (SELECT COUNT(*) FROM agent_claims c
           WHERE c.agent_id = a.id AND c.status = 'verified') AS verified_claims
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id`;
const SCAN_SQL = `${SNAPSHOT_SELECT}
   ORDER BY a.id ASC`;
const SNAPSHOT_SQL = `${SNAPSHOT_SELECT}
   WHERE a.id = ?`;

/** Owner lock: claimed_at OR a verified agent_claims row (the two-source
 * check the url-write sibling documents a production gap for). */
function isOwnerLocked(s: { claimed_at: string | null; verified_claims: number }): boolean {
  return !!s.claimed_at || (s.verified_claims ?? 0) > 0;
}

/** True iff curated_fields locks `fieldName`. Malformed JSON = unlocked. */
export function isFieldCurated(curatedFieldsJson: string | null | undefined, fieldName: string): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    return !!(parsed as Record<string, unknown>)[fieldName];
  } catch {
    return false;
  }
}

/** Which text fields of a row read as theme spam. PURE. */
export function themeSpamFieldsOf(row: { description: string | null; about: string | null }): ThemeSpamField[] {
  const out: ThemeSpamField[] = [];
  if (looksLikeThemeSpam(row.description)) out.push("description");
  if (looksLikeThemeSpam(row.about)) out.push("about");
  return out;
}

function emailHost(email: string | null | undefined): string | null {
  const e = (email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  return e.slice(at + 1).replace(/^www\./, "");
}

function registrable(host: string | null): string | null {
  if (!host) return null;
  const labels = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length < 2) return null;
  return labels.slice(-2).join(".");
}

/** Contact e-mails living on the hijacked host — a warning, never a write. */
export function emailsOnHijackedHost(
  emails: Array<string | null | undefined>,
  hijackedHost: string | null,
): string[] {
  const target = registrable(hijackedHost);
  if (!target) return [];
  const out: string[] = [];
  for (const e of emails) {
    const h = registrable(emailHost(e));
    if (h && h === target && !out.includes((e as string).trim())) out.push((e as string).trim());
  }
  return out;
}

/** Read-only classification of one snapshot — shared by dry-run and the
 * apply path's fresh re-check. PURE. */
export function classifySnapshot(cur: Snapshot): ThemeSpamAgentResult {
  const spamFields = themeSpamFieldsOf(cur);
  const fields: ThemeSpamAgentResult["fields"] = {};
  const ownerLocked = isOwnerLocked(cur);
  let anyWritable = false;
  let preview: string | undefined;
  for (const f of spamFields) {
    const val = f === "description" ? cur.description : cur.about;
    if (preview === undefined) preview = previewValue(val);
    if (ownerLocked) fields[f] = "skipped_claimed";
    else if (isFieldCurated(cur.curated_fields, f)) fields[f] = "skipped_curated";
    else {
      fields[f] = "would_write";
      anyWritable = true;
    }
  }
  const websiteHost = hostFromUrlLike(cur.website || "") || hostFromUrlLike(cur.url || "") || null;
  let website: ThemeSpamSourceOutcome = "none";
  let url: ThemeSpamSourceOutcome = "none";
  if (anyWritable) {
    if ((cur.website || "").trim()) {
      website = ownerLocked ? "skipped_claimed" : isFieldCurated(cur.curated_fields, "website") ? "skipped_curated" : "would_clear";
    }
    if ((cur.url || "").trim()) {
      url = ownerLocked ? "skipped_claimed" : isFieldCurated(cur.curated_fields, "website") ? "skipped_curated" : "would_clear";
    }
  }
  const warnings = emailsOnHijackedHost([cur.contact_email, cur.knowledge_email], websiteHost).map(
    (e) => `contact_email_on_hijacked_host:${e}`,
  );
  const outcome: ThemeSpamAgentResult["outcome"] =
    spamFields.length === 0
      ? "skipped_unchanged"
      : anyWritable
        ? "would_write"
        : ownerLocked
          ? "skipped_claimed"
          : "skipped_curated";
  return {
    agent_id: cur.id,
    name: cur.name,
    fields,
    website,
    url,
    website_host: websiteHost,
    ...(preview !== undefined ? { old_value_preview: preview } : {}),
    ...(warnings.length ? { warnings } : {}),
    outcome,
  };
}

function insertAudit(
  db: ReturnType<typeof getDb>,
  agentId: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
  notes: string,
): void {
  db.prepare(
    `INSERT INTO agent_knowledge_audit
       (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
     VALUES (?, ?, ?, ?, ?, 'system', NULL, datetime('now'), ?)`,
  ).run(randomUUID(), agentId, field, oldValue, newValue, notes);
}

/**
 * Clean ONE agent — fresh re-read of locks + values inside its own
 * transaction, one audit row per changed column.
 */
function applyRow(agentId: string, reason: string, batchTag: string): ThemeSpamAgentResult {
  const db = db_();
  try {
    const tx = db.transaction((): ThemeSpamAgentResult => {
      const cur = db.prepare(SNAPSHOT_SQL).get(agentId) as Snapshot | undefined;
      if (!cur) {
        return { agent_id: agentId, name: "", fields: {}, website: "none", url: "none", outcome: "not_found" };
      }
      const plan = classifySnapshot(cur);
      let wrote = false;
      const notes = `${batchTag}: ${reason}`;
      for (const f of Object.keys(plan.fields) as ThemeSpamField[]) {
        if (plan.fields[f] !== "would_write") continue;
        if (f === "description") {
          db.prepare(`UPDATE agents SET description = '' WHERE id = ?`).run(agentId);
          insertAudit(db, agentId, "description", cur.description, "", notes);
        } else {
          db.prepare(`UPDATE agent_knowledge SET about = NULL WHERE agent_id = ?`).run(agentId);
          insertAudit(db, agentId, "about", cur.about, null, notes);
        }
        plan.fields[f] = "written";
        wrote = true;
      }
      if (wrote) {
        if (plan.website === "would_clear") {
          db.prepare(`UPDATE agent_knowledge SET website = NULL WHERE agent_id = ?`).run(agentId);
          insertAudit(db, agentId, "website", cur.website, null, `${notes} | hijacked source of the cleaned text`);
          plan.website = "cleared";
        }
        if (plan.url === "would_clear") {
          db.prepare(`UPDATE agents SET url = '' WHERE id = ?`).run(agentId);
          insertAudit(db, agentId, "url", cur.url, "", `${notes} | hijacked source of the cleaned text`);
          plan.url = "cleared";
        }
        plan.outcome = "written";
      }
      return plan;
    });
    return tx();
  } catch (e: any) {
    return {
      agent_id: agentId,
      name: "",
      fields: {},
      website: "error",
      url: "error",
      outcome: "error",
      detail: e?.message ?? String(e),
    };
  }
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const db = db_();

  const allRows = db.prepare(SCAN_SQL).all() as Snapshot[];
  const scanned = allRows.length;
  const candidates = allRows.filter((r) => themeSpamFieldsOf(r).length > 0);
  const candidatesConsidered = candidates.length;
  const batch = candidates.slice(0, THEME_SPAM_SWEEP_MAX_ITEMS);

  // Enrichment write-pause gate — on the candidate id set, BEFORE the
  // dry-run branch; fails CLOSED and blocks the WHOLE request (same
  // discipline as every sibling sweep).
  {
    const pauseBlock = enrichmentWritePauseBlockForAgents(
      db_,
      batch.map((c) => c.id),
    );
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  const body = (req.body ?? {}) as { apply?: unknown; reason?: unknown };
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const reason =
    typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "theme-spam-sweep";
  const batchTag = `theme-spam-sweep-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const results: ThemeSpamAgentResult[] = dryRun
    ? batch.map((c) => classifySnapshot(c))
    : batch.map((c) => {
        const r = applyRow(c.id, reason, batchTag);
        return r.name ? r : { ...r, name: c.name };
      });

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const sourceCounts = results.reduce<Record<string, number>>((acc, r) => {
    for (const k of [`website:${r.website}`, `url:${r.url}`]) acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned,
    candidates_considered: candidatesConsidered,
    batch_size: batch.length,
    counts,
    source_counts: sourceCounts,
    results,
  });
});

export default router;
