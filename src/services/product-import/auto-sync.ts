// ─── Weekly product auto-sync from the owner's own website (Skive 4-1) ──────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 4-1:
// BACKEND ONLY, behind PRODUCT_AUTO_SYNC_ENABLED ("1"/"true"; default off).
// For a verified profile (agents.is_verified = 1) whose
// product_auto_sync_state.product_sync_mode is 'weekly', the job re-reads the
// owner's website with the Skive 1 extractor (same-host, robots.txt, SSRF
// guard, per-host pacing) and compares it with the products the OWNER has
// confirmed (source owner_manual / owner_import / owner_auto_sync), matched
// by normalised name as the Skive 3 diff (diffAgainst) does:
//
//   price / unit changed   → applied: the product gets source
//                            'owner_auto_sync', the new price text, sourceUrl
//                            and a new fetchedAt (confirmedAt kept). Its stock
//                            status is not changed.
//   new on the website     → NEVER published: staged as 'pending' candidates
//                            of the run (product_import_runs mode
//                            'auto_sync') for a later owner approval.
//   confirmed, not found   → the catalog row is set out of stock (only when
//                            it was in_stock); the product is never deleted.
//
// Deviation lock — nothing is applied, nothing staged, the reason is stored:
//   - the fetch or the extraction fails (any outcome but 'ok', a timeout, a
//     throw, no products);
//   - more than 50 % of the confirmed products would disappear;
//   - any price would change by more than ±50 %.
// After AUTO_SYNC_MAX_CONSECUTIVE_BLOCKS locks in a row the profile's mode is
// set to 'off' with the reason. A successful run resets the count and records
// the last success and a change summary.
//
// Writes go the owner path as «Publiser valgte» does (ownerPath +
// preStampedProducts, curated_fields.products owner lock, one-profile catalog
// sync). Enrichment products on the profile are never touched.

import { randomUUID } from "crypto";
import { getDb } from "../../database/init";
import { knowledgeService, OWNER_PRODUCT_SOURCES, type ProductInfo } from "../knowledge-service";
import { normalizeName, runProductCatalogSync } from "../product-catalog-sync";
import { auditOwnerProductChange } from "../owner-orderability";
import { getJobLastCompletedAt, markJobCompleted, resolveDailyJobLastRunAt } from "../boot-job-gate";
import { extractProductsFromWebsite, HostPacer, type ProductImportDeps, type ProductImportResult } from "./extractor";
import type { ProductCandidate } from "./structured";
import {
  currentProductsOf,
  diffAgainst,
  formatPrice,
  OWNER_FETCH_HOST_INTERVAL_MS,
  OWNER_FETCH_TIMEOUT_MS,
  profileWebsite,
  readCurrentList,
  type CurrentProduct,
} from "./owner-import";

export const PRODUCT_AUTO_SYNC_FLAG = "PRODUCT_AUTO_SYNC_ENABLED";
export const AUTO_SYNC_INTERVAL_DAYS = 7;
export const AUTO_SYNC_MAX_CONSECUTIVE_BLOCKS = 3;
/** Lock when more than this share of the confirmed products is not found. */
export const AUTO_SYNC_MAX_MISSING_SHARE = 0.5;
/** Lock when any price changes by more than this share (either way). */
export const AUTO_SYNC_MAX_PRICE_CHANGE = 0.5;
/** Pause between two profiles in one sweep (the host pacer works per host on top). */
export const AUTO_SYNC_PROFILE_DELAY_MS = 2000;
/** At most this many profiles per sweep; the rest wait for the next day's sweep. */
export const AUTO_SYNC_MAX_PROFILES_PER_SWEEP = 50;
/** boot_job_state key of the sweep's "ran today" stamp. */
export const AUTO_SYNC_JOB_STATE_KEY = "product-auto-sync-weekly";
export const AUTO_SYNC_WINDOW_HOUR_UTC = 3;
export const AUTO_SYNC_MIN_HOURS_BETWEEN_SWEEPS = 20;

export type ProductSyncMode = "off" | "weekly";

/** Flag: "1"/"true" turns the weekly auto-sync on. Anything else = off. */
export function productAutoSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[PRODUCT_AUTO_SYNC_FLAG];
  return v === "1" || v === "true";
}

export interface AutoSyncDeps extends Pick<ProductImportDeps, "fetchImpl" | "llm" | "sleep" | "timeoutMs"> {
  now?: () => number;
  hostIntervalMs?: number;
  jobTimeoutMs?: number;
  /** Shared pacer for a sweep (one per sweep, so two profiles on one host are paced). */
  pacer?: HostPacer;
  /** LLM calls one profile's fetch may make (default 1, as the owner fetch). */
  llmCap?: number;
  profileDelayMs?: number;
  maxProfiles?: number;
  env?: NodeJS.ProcessEnv;
}

// ── State ──────────────────────────────────────────────────────────────────

export interface AutoSyncStateRow {
  agent_id: string;
  product_sync_mode: string;
  consecutive_blocks: number;
  last_run_at: string | null;
  last_run_id: string | null;
  last_success_at: string | null;
  last_change_summary: string | null;
  last_block_reason: string | null;
  disabled_reason: string | null;
  disabled_at: string | null;
}

export function readAutoSyncState(agentId: string): AutoSyncStateRow | null {
  const row = getDb()
    .prepare(
      `SELECT agent_id, product_sync_mode, consecutive_blocks, last_run_at, last_run_id, last_success_at,
              last_change_summary, last_block_reason, disabled_reason, disabled_at
         FROM product_auto_sync_state WHERE agent_id = ?`,
    )
    .get(agentId) as AutoSyncStateRow | undefined;
  return row ?? null;
}

/** Sets a profile's mode (no route calls this yet; a later slice adds the owner toggle). */
export function setProductSyncMode(agentId: string, mode: ProductSyncMode): void {
  getDb()
    .prepare(
      `INSERT INTO product_auto_sync_state (agent_id, product_sync_mode, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(agent_id) DO UPDATE SET product_sync_mode = excluded.product_sync_mode, updated_at = datetime('now'),
         consecutive_blocks = CASE WHEN excluded.product_sync_mode = 'weekly' THEN 0 ELSE consecutive_blocks END,
         disabled_reason = CASE WHEN excluded.product_sync_mode = 'weekly' THEN NULL ELSE disabled_reason END,
         disabled_at = CASE WHEN excluded.product_sync_mode = 'weekly' THEN NULL ELSE disabled_at END`,
    )
    .run(agentId, mode);
}

const sqlTs = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const isoTs = (ms: number): string => new Date(ms).toISOString();

// ── Plan (PURE) ────────────────────────────────────────────────────────────

export interface AutoSyncChange {
  current: CurrentProduct;
  candidate: ProductCandidate;
  new_price_nok: number | null;
  new_unit: string | null;
}

export type AutoSyncPlan =
  | {
      ok: true;
      confirmed: number;
      changes: AutoSyncChange[];
      notFound: CurrentProduct[];
      newCandidates: ProductCandidate[];
    }
  | { ok: false; reason: string };

/** Is a stored product owner-confirmed (owner_manual / owner_import / owner_auto_sync)? */
export function isOwnerConfirmed(p: CurrentProduct): boolean {
  return p.source !== null && (OWNER_PRODUCT_SOURCES as readonly string[]).includes(p.source);
}

/**
 * The run's plan against the profile's current products, or the lock reason.
 * PURE: `candidates` are the extractor's products, `current` the profile's.
 */
export function planAutoSync(candidates: ProductCandidate[], current: CurrentProduct[]): AutoSyncPlan {
  // One candidate per name (the first), as the staging / diff key.
  const seen = new Set<string>();
  const cands: ProductCandidate[] = [];
  for (const c of candidates) {
    const key = normalizeName(c.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cands.push(c);
  }
  const confirmed = current.filter(isOwnerConfirmed);
  const diff = diffAgainst(cands.map((c) => ({ key: normalizeName(c.name), price_nok: c.price_nok, unit: c.unit })), confirmed);
  if (confirmed.length > 0 && diff.notFound.length / confirmed.length > AUTO_SYNC_MAX_MISSING_SHARE) {
    return {
      ok: false,
      reason: `too_many_missing: ${diff.notFound.length} av ${confirmed.length} bekreftede varer finnes ikke på nettsiden`,
    };
  }
  const changes: AutoSyncChange[] = [];
  const newCandidates: ProductCandidate[] = [];
  const deviations: string[] = [];
  cands.forEach((c, i) => {
    const k = diff.kinds[i]!;
    if (k.kind === "new") {
      newCandidates.push(c);
      return;
    }
    if (k.kind !== "changed") return;
    const cur = k.current!;
    const newPrice = c.price_nok !== null ? c.price_nok : cur.price_nok;
    if (c.price_nok !== null && cur.price_nok !== null && cur.price_nok > 0) {
      const share = Math.abs(c.price_nok - cur.price_nok) / cur.price_nok;
      if (share > AUTO_SYNC_MAX_PRICE_CHANGE) {
        const pct = Math.round(((c.price_nok - cur.price_nok) / cur.price_nok) * 100);
        deviations.push(`${cur.name} ${cur.price_nok} → ${c.price_nok} (${pct > 0 ? "+" : ""}${pct} %)`);
      }
    }
    changes.push({ current: cur, candidate: c, new_price_nok: newPrice, new_unit: c.unit ?? cur.unit });
  });
  if (deviations.length) return { ok: false, reason: `price_deviation: ${deviations.join("; ")}`.slice(0, 500) };
  return { ok: true, confirmed: confirmed.length, changes, notFound: diff.notFound, newCandidates };
}

// ── One profile ────────────────────────────────────────────────────────────

export type AutoSyncProfileResult =
  | { status: "skipped"; agent_id: string; reason: "not_verified" | "mode_off" | "no_website" }
  | { status: "blocked"; agent_id: string; run_id: string; reason: string; consecutive_blocks: number; mode_turned_off: boolean }
  | {
      status: "applied";
      agent_id: string;
      run_id: string;
      changed: number;
      not_found: number;
      new_pending: number;
      catalog_sync: "ok" | "failed" | "not_needed";
    };

/** Why a profile may not be auto-synced now, or null when it may. Never writes. */
export function autoSyncSkipReason(agentId: string): "not_verified" | "mode_off" | "no_website" | null {
  const db = getDb();
  const a = db.prepare(`SELECT is_verified FROM agents WHERE id = ?`).get(agentId) as { is_verified?: number } | undefined;
  if (!a || a.is_verified !== 1) return "not_verified";
  const s = readAutoSyncState(agentId);
  if (!s || s.product_sync_mode !== "weekly") return "mode_off";
  if (!profileWebsite(agentId)) return "no_website";
  return null;
}

/** Runs one auto-sync for one profile. Never throws for a fetch problem (that is a lock). */
export async function runAutoSyncForProfile(agentId: string, deps: AutoSyncDeps = {}): Promise<AutoSyncProfileResult> {
  const now = deps.now ?? Date.now;
  const skip = autoSyncSkipReason(agentId);
  if (skip) return { status: "skipped", agent_id: agentId, reason: skip };
  const db = getDb();
  const website = profileWebsite(agentId)!;
  const startedMs = now();
  const runId = `pias-${new Date(startedMs).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const llmCap = deps.llmCap ?? 1;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO product_import_runs (id, mode, status, params_json, profiles_total, llm_call_cap, agent_id, created_at)
       VALUES (?, 'auto_sync', 'running', ?, 1, ?, ?, ?)`,
    ).run(runId, JSON.stringify({ website }), llmCap, agentId, sqlTs(startedMs));
    // Stamped at the start, so a restart mid-run does not run the profile again this week.
    db.prepare(`UPDATE product_auto_sync_state SET last_run_at = ?, last_run_id = ?, updated_at = datetime('now') WHERE agent_id = ?`)
      .run(isoTs(startedMs), runId, agentId);
  })();

  let result: ProductImportResult | null = null;
  let failure: string | null = null;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), deps.jobTimeoutMs ?? OWNER_FETCH_TIMEOUT_MS);
      (timer as any)?.unref?.();
    });
    const extraction = extractProductsFromWebsite(website, {
      fetchImpl: deps.fetchImpl,
      llm: deps.llm,
      sleep: deps.sleep,
      now: deps.now,
      timeoutMs: deps.timeoutMs,
      llmBudget: { cap: llmCap, used: 0 },
      pacer: deps.pacer ?? new HostPacer(deps.hostIntervalMs ?? OWNER_FETCH_HOST_INTERVAL_MS, deps.now, deps.sleep),
    });
    const r = await Promise.race([extraction, timeout]);
    if (timer) clearTimeout(timer);
    if (r === "timeout") {
      failure = "fetch_failed: timeout";
      await extraction.catch(() => undefined);
    } else if (r.outcome !== "ok" || r.products.length === 0) {
      failure = `fetch_failed: ${r.outcome}`;
      result = r;
    } else {
      result = r;
    }
  } catch (err) {
    failure = `fetch_failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
  }

  // Everything below runs in one synchronous stretch: the current list is
  // read and written without an await in between.
  if (failure) return recordBlock(agentId, runId, failure, result, now());
  const list = readCurrentList(agentId).slice();
  const current = currentProductsOf(list);
  const plan = planAutoSync(result!.products, current);
  if (!plan.ok) return recordBlock(agentId, runId, plan.reason, result, now());
  return applyPlan(agentId, runId, list, plan, result!, now());
}

function summaryOf(result: ProductImportResult | null): Record<string, unknown> | null {
  if (!result) return null;
  return {
    outcome: result.outcome,
    tier: result.tier,
    pages_fetched: result.pages_fetched,
    llm_calls: result.llm_calls,
    llm_status: result.llm_status,
    products: result.products.length,
    robots_skipped: result.robots_skipped.length,
    rejected_urls: result.rejected_urls.length,
    duration_ms: result.duration_ms,
  };
}

function recordBlock(agentId: string, runId: string, reason: string, result: ProductImportResult | null, nowMs: number): AutoSyncProfileResult {
  const db = getDb();
  let blocks = 0;
  let turnedOff = false;
  db.transaction(() => {
    db.prepare(
      `UPDATE product_import_runs SET status = 'blocked', outcome = ?, tier = ?, llm_calls = ?, error = ?, summary_json = ?,
              profiles_done = 1, finished_at = ?
        WHERE id = ?`,
    ).run(
      reason.split(":")[0], result?.tier ?? null, result?.llm_calls ?? 0, reason.slice(0, 500),
      JSON.stringify(summaryOf(result)), sqlTs(nowMs), runId,
    );
    const s = readAutoSyncState(agentId);
    blocks = (s?.consecutive_blocks ?? 0) + 1;
    turnedOff = blocks >= AUTO_SYNC_MAX_CONSECUTIVE_BLOCKS;
    db.prepare(
      `UPDATE product_auto_sync_state
          SET consecutive_blocks = ?, last_block_reason = ?, updated_at = datetime('now'),
              product_sync_mode = CASE WHEN ? THEN 'off' ELSE product_sync_mode END,
              disabled_reason = CASE WHEN ? THEN ? ELSE disabled_reason END,
              disabled_at = CASE WHEN ? THEN ? ELSE disabled_at END
        WHERE agent_id = ?`,
    ).run(
      blocks, reason.slice(0, 500),
      turnedOff ? 1 : 0,
      turnedOff ? 1 : 0, `${blocks} låste kjøringer på rad; siste: ${reason}`.slice(0, 500),
      turnedOff ? 1 : 0, isoTs(nowMs),
      agentId,
    );
  })();
  return { status: "blocked", agent_id: agentId, run_id: runId, reason, consecutive_blocks: blocks, mode_turned_off: turnedOff };
}

function applyPlan(
  agentId: string,
  runId: string,
  list: ProductInfo[],
  plan: Extract<AutoSyncPlan, { ok: true }>,
  result: ProductImportResult,
  nowMs: number,
): AutoSyncProfileResult {
  const db = getDb();
  const nowIso = isoTs(nowMs);
  const nowSql = sqlTs(nowMs);
  const merged = list.slice();
  for (const ch of plan.changes) {
    const c = ch.candidate;
    const base: ProductInfo = { ...list[ch.current.index]! };
    const price = formatPrice(ch.new_price_nok, ch.new_unit, c.price_is_from, c.price_excl_vat === true);
    const entry: ProductInfo = { ...base, source: "owner_auto_sync", fetchedAt: nowIso };
    if (c.source_url) entry.sourceUrl = c.source_url;
    if (price !== undefined) {
      entry.price = price;
      entry.priceUnit = "kr";
    }
    merged[ch.current.index] = entry;
  }
  const changeSummary = {
    run_id: runId,
    at: nowIso,
    changed: plan.changes.map((ch) => ({
      name: ch.current.name,
      old_price_nok: ch.current.price_nok,
      new_price_nok: ch.new_price_nok,
      old_unit: ch.current.unit,
      new_unit: ch.new_unit,
    })),
    not_found: plan.notFound.map((p) => p.name),
    new_pending: plan.newCandidates.length,
  };

  db.transaction(() => {
    if (plan.changes.length > 0) {
      knowledgeService.upsertKnowledge(agentId, { products: merged, dataSource: "owner" }, { ownerPath: true, preStampedProducts: true });
      knowledgeService.setCuratedFieldLock(agentId, "products", {
        locked_at: nowIso,
        by: "owner",
        request_summary: "ukentlig synk fra egen nettside (owner_auto_sync)",
      });
      auditOwnerProductChange(
        db, agentId, "products.auto_synced",
        plan.changes.map((ch) => `${ch.current.name}: ${ch.current.price ?? ""}`).join(", ").slice(0, 2000),
        plan.changes.map((ch) => `${ch.current.name}: ${ch.new_price_nok ?? ""}${ch.new_unit ? `/${ch.new_unit}` : ""}`).join(", ").slice(0, 2000),
        null,
        `weekly auto-sync updated ${plan.changes.length} product(s) in run ${runId} (produktimport skive 4-1)`,
      );
    }
    // New products: staged only, for a later owner approval.
    const insert = db.prepare(
      `INSERT INTO product_import_candidates
         (id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
          pack_size, tier, source_url, rules_json, fetched_at, status, diff_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'new', ?)`,
    );
    plan.newCandidates.forEach((p, i) => {
      insert.run(
        `pic-${randomUUID()}`, runId, agentId, i, p.name, normalizeName(p.name), p.price_nok, p.price_text ?? "", p.unit,
        p.price_is_from ? 1 : 0, p.price_excl_vat ? 1 : 0, p.pack_size ?? null, p.tier, p.source_url ?? null,
        JSON.stringify(p.rules ?? []), nowIso, nowSql,
      );
    });
  })();

  // Catalog rows for this profile (as publish does), then the catalog-only
  // corrections the sync itself never writes: the unit, and «not found» →
  // out of stock (never deleted).
  let catalog_sync: "ok" | "failed" | "not_needed" = "not_needed";
  if (plan.changes.length > 0 || plan.notFound.length > 0) {
    const r = runProductCatalogSync(db, { agentId });
    catalog_sync = r.success ? "ok" : "failed";
    if (!r.success) console.error("[product-auto-sync] catalog sync failed:", r.error);
  }
  let outOfStock = 0;
  db.transaction(() => {
    const setUnit = db.prepare(`UPDATE products SET unit = ?, updated_at = datetime('now') WHERE agent_id = ? AND name_norm = ? AND unit IS NOT ?`);
    for (const ch of plan.changes) {
      if (ch.new_unit && ch.new_unit !== ch.current.unit) setUnit.run(ch.new_unit, agentId, ch.current.key, ch.new_unit);
    }
    const setOut = db.prepare(
      `UPDATE products SET availability = 'out_of_stock', availability_updated_at = datetime('now'), updated_at = datetime('now')
        WHERE agent_id = ? AND name_norm = ? AND availability = 'in_stock'`,
    );
    for (const p of plan.notFound) outOfStock += setOut.run(agentId, p.key).changes;
    if (outOfStock > 0) {
      auditOwnerProductChange(
        db, agentId, "products.availability", "in_stock", "out_of_stock", null,
        `weekly auto-sync: ${outOfStock} product(s) not found on the website set out of stock in run ${runId} (produktimport skive 4-1)`,
      );
    }
    db.prepare(
      `UPDATE product_import_runs
          SET status = 'completed', outcome = ?, tier = ?, profiles_done = 1, llm_calls = ?,
              count_new = ?, count_changed = ?, count_not_found = ?, count_published = ?, summary_json = ?, finished_at = ?
        WHERE id = ?`,
    ).run(
      result.outcome, result.tier, result.llm_calls, plan.newCandidates.length, plan.changes.length, plan.notFound.length,
      plan.changes.length, JSON.stringify({ ...summaryOf(result), catalog_sync, out_of_stock: outOfStock }), nowSql, runId,
    );
    db.prepare(
      `UPDATE product_auto_sync_state
          SET consecutive_blocks = 0, last_success_at = ?, last_change_summary = ?, updated_at = datetime('now')
        WHERE agent_id = ?`,
    ).run(nowIso, JSON.stringify({ ...changeSummary, out_of_stock: outOfStock }), agentId);
  })();
  return {
    status: "applied",
    agent_id: agentId,
    run_id: runId,
    changed: plan.changes.length,
    not_found: plan.notFound.length,
    new_pending: plan.newCandidates.length,
    catalog_sync,
  };
}

// ── Sweep + weekly tick ────────────────────────────────────────────────────

/** Profiles due now: verified, mode 'weekly', last run ≥ 7 days ago (or never). Never writes. */
export function dueAutoSyncProfiles(nowMs: number, limit = AUTO_SYNC_MAX_PROFILES_PER_SWEEP): string[] {
  const rows = getDb()
    .prepare(
      `SELECT s.agent_id, s.last_run_at FROM product_auto_sync_state s
         JOIN agents a ON a.id = s.agent_id
        WHERE s.product_sync_mode = 'weekly' AND a.is_verified = 1
        ORDER BY COALESCE(s.last_run_at, '') ASC, s.agent_id ASC`,
    )
    .all() as Array<{ agent_id: string; last_run_at: string | null }>;
  const minAge = AUTO_SYNC_INTERVAL_DAYS * 86_400_000;
  const out: string[] = [];
  for (const r of rows) {
    const t = r.last_run_at ? Date.parse(r.last_run_at) : NaN;
    if (Number.isNaN(t) || nowMs - t >= minAge) out.push(r.agent_id);
    if (out.length >= limit) break;
  }
  return out;
}

export interface AutoSyncSweepReport {
  started_at: string;
  profiles: number;
  applied: number;
  blocked: number;
  skipped: number;
  errors: number;
  results: AutoSyncProfileResult[];
}

/** One sweep: every due profile, one after another, with a pause between them. */
export async function runAutoSyncSweep(deps: AutoSyncDeps = {}): Promise<AutoSyncSweepReport> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pacer = deps.pacer ?? new HostPacer(deps.hostIntervalMs ?? OWNER_FETCH_HOST_INTERVAL_MS, deps.now, deps.sleep);
  const due = dueAutoSyncProfiles(now(), deps.maxProfiles ?? AUTO_SYNC_MAX_PROFILES_PER_SWEEP);
  const report: AutoSyncSweepReport = { started_at: isoTs(now()), profiles: due.length, applied: 0, blocked: 0, skipped: 0, errors: 0, results: [] };
  for (let i = 0; i < due.length; i++) {
    if (i > 0) await sleep(deps.profileDelayMs ?? AUTO_SYNC_PROFILE_DELAY_MS);
    try {
      const r = await runAutoSyncForProfile(due[i]!, { ...deps, pacer });
      report.results.push(r);
      if (r.status === "applied") report.applied++;
      else if (r.status === "blocked") report.blocked++;
      else report.skipped++;
    } catch (err) {
      report.errors++;
      console.error(`[product-auto-sync] ${due[i]} failed (non-fatal):`, err instanceof Error ? err.message : err);
    }
  }
  return report;
}

/** Pure scheduling guard: inside the window hour and ≥ 20 h after the last sweep. */
export function shouldRunAutoSyncSweep(opts: { now: Date; lastRunAt: Date | null }): boolean {
  if (opts.now.getUTCHours() !== AUTO_SYNC_WINDOW_HOUR_UTC) return false;
  if (opts.lastRunAt && opts.now.getTime() - opts.lastRunAt.getTime() < AUTO_SYNC_MIN_HOURS_BETWEEN_SWEEPS * 3600_000) return false;
  return true;
}

/**
 * The index.ts tick. Flag off → returns at once and writes nothing. Else, once
 * a day inside the window (stamp persisted in boot_job_state, so a restart
 * does not sweep twice), runs the profiles that are due (≥ 7 days since their
 * own last run, also persisted).
 */
export async function tickProductAutoSync(
  opts: { now: Date; lastRunAt: Date | null },
  deps: AutoSyncDeps = {},
): Promise<{ lastRunAt: Date | null; report: AutoSyncSweepReport | null }> {
  if (!productAutoSyncEnabled(deps.env ?? process.env)) return { lastRunAt: opts.lastRunAt, report: null };
  const db = getDb();
  const lastRunAt = resolveDailyJobLastRunAt(db, AUTO_SYNC_JOB_STATE_KEY, opts.lastRunAt, opts.now);
  if (!shouldRunAutoSyncSweep({ now: opts.now, lastRunAt })) return { lastRunAt, report: null };
  // Stamped before the sweep: a crash or deploy mid-sweep does not start it again today.
  markJobCompleted(db, AUTO_SYNC_JOB_STATE_KEY, opts.now);
  const report = await runAutoSyncSweep(deps);
  return { lastRunAt: opts.now, report };
}

/** Last sweep stamp (read-only; for logs / a later status view). */
export function lastAutoSyncSweepAt(): Date | null {
  return getJobLastCompletedAt(getDb(), AUTO_SYNC_JOB_STATE_KEY);
}
