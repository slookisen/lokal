/**
 * admin-profile-translations.ts — dev-request
 * 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent: the admin surface the
 * two translation routines (A2A scheduled-agents/rfb-profile-translation.md
 * and opplevagent-profile-translation.md) drive, plus the manual-QA verbs
 * Daniel / the routine's spot-check use before a pulje is published.
 *
 * Mounted at /admin/profile-translations (src/index.ts) on the main app, so
 * BOTH platforms are driven through rettfrabonden.com — `platform` is a body/
 * query parameter ("rfb" | "opplevagent") and picks the SQLite file
 * (database/init getDb() vs db-factory getDb("experiences")).
 *
 *   GET  /status?platform=          counts per lang × status + the flags
 *   GET  /queue?platform=&lang=&status=&limit=&entity_id=
 *                                   rows for review (source + translation +
 *                                   review/verify JSON + reason)
 *   GET  /preview?platform=&entity_type=&entity_id=&lang=
 *                                   side-by-side for one entity (verified +
 *                                   published, ignores the serve flag)
 *   GET  /audit?platform=&id=       status history of one row
 *   POST /run                       {platform, langs?, limit?, dry_run?, entity_ids?}
 *                                   collect → translate → review → verify.
 *                                   Gated by PROFILE_TRANSLATIONS_ENABLED
 *                                   (LLM spend). dry_run is STRICT-FALSE:
 *                                   only the JSON boolean `false` runs the
 *                                   LLM; anything else plans only.
 *   POST /publish                   {platform, lang, ids?, dry_run?}
 *                                   verified → published (the pulje flip).
 *                                   dry_run STRICT-FALSE.
 *   POST /unpublish                 {platform, lang, ids?, reason?}
 *                                   published → verified (kill switch per
 *                                   platform/lang, complements the serve flag)
 *   POST /reject                    {platform, id, reason}
 *   POST /requeue                   {platform, id}
 *
 *   Session lane (2026-09-03, Daniel: no Anthropic API spend — the Claude Code
 *   session / Cloud Routine session translates and reviews itself):
 *   GET  /collect?platform=&langs=&limit=&entity_ids=
 *                                   plan + materialise drafts, return source
 *                                   texts and the translator/reviewer
 *                                   instructions. No LLM call, no flag gate.
 *   POST /submit                    {platform, items:[{id, source_hash?, translated_text,
 *                                   already_target_language?, kept_terms?, notes?, review}], actor?}
 *                                   store translation + independent review verdict,
 *                                   run the deterministic verifier → verified |
 *                                   rejected. Publishes only when the row was
 *                                   published before AND the entity is not
 *                                   owner-claimed AND the auto-republish flag
 *                                   is on. Max 200 items.
 *   POST /sweep-stale               {platform, dry_run?, limit?}
 *                                   hash-compare published/verified rows against
 *                                   the live Norwegian source and reset the ones
 *                                   that changed or disappeared. No LLM, no spend,
 *                                   only ever moves rows AWAY from published.
 *                                   dry_run STRICT-FALSE.
 *
 * Auth: X-Admin-Key vs ADMIN_KEY / ANALYTICS_ADMIN_KEY — same guard as every
 * other /admin/* route (503 when unconfigured, 403 on mismatch).
 *
 * Test seam: `app.set("profileTranslationsFetchImpl", fn)` replaces the
 * Anthropic fetch (same idiom as titleNoBackfillFetchImpl in opplevelser.ts)
 * so tests never clobber globalThis.fetch.
 */

import { Router, type Request, type Response } from "express";
import { getDb as getRfbDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import {
  TRANSLATION_PLATFORMS,
  TRANSLATION_TARGET_LANGS,
  type TranslationPlatform,
  type TranslationTargetLang,
  type TranslationStatus,
  type ItemResult,
  isProfileTranslationPipelineEnabled,
  isProfileTranslationServingEnabled,
  translatorModel,
  reviewerModel,
  planTranslationBatch,
  processTranslationItem,
  publishVerified,
  unpublish,
  rejectTranslation,
  requeueTranslation,
  translationStatusCounts,
  listTranslationQueue,
  listTranslationAudit,
  getPublishedProfileTranslations,
  collectSourceItems,
  PROFILE_TRANSLATION_FIELDS,
  collectForSession,
  submitSessionTranslation,
  type SessionSubmission,
  sweepStaleTranslations,
  listTranslationQueueWithClaims,
  isAutoRepublishEnabled,
} from "../services/profile-translations";
import { isSvLocaleEnabled } from "../i18n/t";
import { getWorkerState, tryAcquireTranslationRunLock, releaseTranslationRunLock } from "../services/profile-translations-worker";

const router = Router();

/** Hard per-call cap on LLM items so a runaway routine cannot burn budget. */
export const PROFILE_TRANSLATIONS_RUN_MAX_ITEMS = 40;
export const PROFILE_TRANSLATIONS_RUN_DEFAULT_ITEMS = 10;
/** Session lane caps: collect/submit carry no LLM spend, so they may be larger. */
export const PROFILE_TRANSLATIONS_COLLECT_MAX_ITEMS = 200;
export const PROFILE_TRANSLATIONS_COLLECT_DEFAULT_ITEMS = 40;
export const PROFILE_TRANSLATIONS_SUBMIT_MAX_ITEMS = 200;

function requireAdmin(req: Request, res: Response): boolean {
  const adminKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY;
  if (!adminKey) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = req.headers["x-admin-key"];
  if (!provided || provided !== adminKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

function parsePlatform(raw: unknown): TranslationPlatform | null {
  const p = String(raw || "").trim();
  return (TRANSLATION_PLATFORMS as string[]).includes(p) ? (p as TranslationPlatform) : null;
}

function parseLang(raw: unknown): TranslationTargetLang | null {
  const l = String(raw || "").trim();
  return (TRANSLATION_TARGET_LANGS as string[]).includes(l) ? (l as TranslationTargetLang) : null;
}

function parseLangs(raw: unknown): TranslationTargetLang[] | null {
  if (raw === undefined || raw === null || raw === "") return [...TRANSLATION_TARGET_LANGS];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  const out: TranslationTargetLang[] = [];
  for (const a of arr) {
    const l = parseLang(a);
    if (!l) return null;
    if (!out.includes(l)) out.push(l);
  }
  return out.length ? out : null;
}

function dbFor(platform: TranslationPlatform) {
  return platform === "rfb" ? getRfbDb() : getVerticalDb("experiences");
}

/** STRICT-FALSE dry-run parse: only the JSON boolean `false` means "write". */
function strictDryRun(body: any): boolean {
  return body?.dry_run !== false;
}

function batchIdFor(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

function flagsSnapshot() {
  return {
    pipeline_enabled: isProfileTranslationPipelineEnabled(),
    serve_enabled: isProfileTranslationServingEnabled(),
    sv_locale_enabled: isSvLocaleEnabled(),
    auto_republish_enabled: isAutoRepublishEnabled(),
    translator_model: translatorModel(),
    reviewer_model: reviewerModel(),
  };
}

// ── GET /status ──────────────────────────────────────────────────────────
router.get("/status", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const platform = parsePlatform(req.query.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  try {
    const db = dbFor(platform);
    const counts = translationStatusCounts(db, platform);
    // Coverage: how many translatable (item × lang) pairs exist right now,
    // and how many of them are published/verified — the routine's headline.
    const items = collectSourceItems(db, platform);
    const pairs = items.length * TRANSLATION_TARGET_LANGS.length;
    const perLang: Record<string, { source_fields: number; published: number; verified: number; coverage_published_pct: number }> = {};
    for (const lang of TRANSLATION_TARGET_LANGS) {
      const c = counts[lang] || {};
      const published = c.published || 0;
      const verified = c.verified || 0;
      perLang[lang] = {
        source_fields: items.length,
        published,
        verified,
        coverage_published_pct: items.length ? Math.round((published / items.length) * 1000) / 10 : 0,
      };
    }
    return res.json({
      platform,
      flags: flagsSnapshot(),
      worker: getWorkerState(),
      fields: PROFILE_TRANSLATION_FIELDS[platform],
      source_fields_total: items.length,
      pairs_total: pairs,
      counts,
      coverage: perLang,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── GET /queue ───────────────────────────────────────────────────────────
router.get("/queue", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const platform = parsePlatform(req.query.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const lang = req.query.lang ? parseLang(req.query.lang) : undefined;
  if (req.query.lang && !lang) return res.status(400).json({ error: "lang må være en eller sv" });
  const statusRaw = req.query.status ? String(req.query.status) : undefined;
  const validStatus: TranslationStatus[] = ["draft", "reviewed", "verified", "published", "rejected"];
  if (statusRaw && !(validStatus as string[]).includes(statusRaw)) return res.status(400).json({ error: `status må være en av ${validStatus.join(", ")}` });
  try {
    const rows = listTranslationQueueWithClaims(dbFor(platform), platform, {
      lang: lang || undefined,
      status: statusRaw as TranslationStatus | undefined,
      limit: Number(req.query.limit) || 50,
      entityId: req.query.entity_id ? String(req.query.entity_id) : undefined,
    });
    return res.json({
      platform,
      count: rows.length,
      rows: rows.map((r) => ({
        id: r.id,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        entity_name: r.entity_name,
        field: r.field,
        lang: r.lang,
        status: r.status,
        attempts: r.attempts,
        source_text: r.source_text,
        translated_text: r.translated_text,
        translator_model: r.translator_model,
        reviewer_model: r.reviewer_model,
        translator_notes: r.translator_notes,
        review: safeJson(r.review_json),
        verify: safeJson(r.verify_json),
        reject_reason: r.reject_reason,
        batch_id: r.batch_id,
        updated_at: r.updated_at,
        published_at: r.published_at,
        previously_published: Number(r.previously_published ?? 0) === 1,
        owner_claimed: r.owner_claimed,
      })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

// ── GET /preview ─────────────────────────────────────────────────────────
router.get("/preview", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const platform = parsePlatform(req.query.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const lang = parseLang(req.query.lang);
  if (!lang) return res.status(400).json({ error: "lang må være en eller sv" });
  const entityType = String(req.query.entity_type || "");
  const entityId = String(req.query.entity_id || "");
  if (!entityType || !entityId) return res.status(400).json({ error: "entity_type og entity_id er påkrevd" });
  try {
    const db = dbFor(platform);
    const source = collectSourceItems(db, platform, { entityIds: [entityId] }).filter((i) => i.entity_type === entityType);
    const published = getPublishedProfileTranslations(db, platform, entityType, entityId, lang, { ignoreServeFlag: true });
    const verifiedOrPublished = getPublishedProfileTranslations(db, platform, entityType, entityId, lang, { ignoreServeFlag: true, includeVerified: true });
    const fields = source.map((s) => ({
      field: s.field,
      source_text: s.text,
      published_text: published[s.field] ?? null,
      verified_or_published_text: verifiedOrPublished[s.field] ?? null,
    }));
    return res.json({ platform, entity_type: entityType, entity_id: entityId, entity_name: source[0]?.entity_name ?? null, lang, fields, flags: flagsSnapshot() });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── GET /audit ───────────────────────────────────────────────────────────
router.get("/audit", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const platform = parsePlatform(req.query.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "id må være et positivt heltall" });
  try {
    return res.json({ platform, id, audit: listTranslationAudit(dbFor(platform), id) });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── POST /run ────────────────────────────────────────────────────────────
router.post("/run", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;
  const platform = parsePlatform(body.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const langs = parseLangs(body.langs);
  if (!langs) return res.status(400).json({ error: "langs må være en liste av en/sv" });
  const limitRaw = Number(body.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(PROFILE_TRANSLATIONS_RUN_MAX_ITEMS, Math.floor(limitRaw))
    : PROFILE_TRANSLATIONS_RUN_DEFAULT_ITEMS;
  const dryRun = strictDryRun(body);
  const entityIds = Array.isArray(body.entity_ids) ? body.entity_ids.map((s: unknown) => String(s)).filter(Boolean).slice(0, 500) : undefined;

  // Flag gate: the pipeline spends LLM budget, so with the flag off the
  // endpoint is a pure {enabled:false} no-op — no reads, no writes, no fetch.
  if (!dryRun && !isProfileTranslationPipelineEnabled()) {
    return res.json({ enabled: false, dry_run: false, platform, note: "PROFILE_TRANSLATIONS_ENABLED er ikke 'true' — ingen LLM-kall, ingen skriving" });
  }

  try {
    const db = dbFor(platform);
    const plan = planTranslationBatch(db, platform, langs, limit, { entityIds });
    const planned = plan.actionable.map((p) => ({
      entity_type: p.item.entity_type,
      entity_id: p.item.entity_id,
      entity_name: p.item.entity_name,
      field: p.item.field,
      lang: p.lang,
      action: p.decision.action,
      source_chars: p.item.text.length,
    }));
    if (dryRun) {
      return res.json({
        enabled: isProfileTranslationPipelineEnabled(),
        dry_run: true,
        platform,
        langs,
        limit,
        flags: flagsSnapshot(),
        planned_count: planned.length,
        remaining_after_this_batch: plan.remaining_actionable,
        skipped: plan.skipped,
        pairs_total: plan.total_pairs,
        planned,
      });
    }

    // Single-flight with the in-process worker (profile-translations-worker.ts):
    // an item must never be on two belts at once.
    const lockHolder = `admin-run-${platform}`;
    if (!tryAcquireTranslationRunLock(lockHolder)) {
      return res.status(409).json({ error: "busy", note: "en annen kjøring (worker eller admin) holder låsen — prøv igjen senere", lock: getWorkerState().lock });
    }
    const batchId = batchIdFor(`tr-${platform}`);
    const fetchImpl = (req.app?.get?.("profileTranslationsFetchImpl") as typeof fetch | undefined) ?? undefined;
    const results: ItemResult[] = [];
    const outcomes: Record<string, number> = {};
    const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
    try {
      for (const p of plan.actionable) {
        const r = await processTranslationItem(db, platform, p, batchId, { fetchImpl });
        results.push(r);
        outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
        usage.input_tokens += r.usage.input_tokens;
        usage.output_tokens += r.usage.output_tokens;
        usage.calls += r.usage.calls;
        // Stop early when the LLM itself is unreachable (missing key / network)
        // so one broken run does not burn every item's attempt budget.
        if (r.outcome === "translate_failed" && /ANTHROPIC_API_KEY|nettverksfeil|status 4\d\d/.test(r.reason || "")) {
          break;
        }
      }
    } finally {
      releaseTranslationRunLock(lockHolder);
    }
    return res.json({
      enabled: true,
      dry_run: false,
      platform,
      langs,
      limit,
      batch_id: batchId,
      flags: flagsSnapshot(),
      processed: results.length,
      planned_count: plan.actionable.length,
      remaining_after_this_batch: plan.remaining_actionable + (plan.actionable.length - results.length),
      skipped: plan.skipped,
      pairs_total: plan.total_pairs,
      outcomes,
      usage,
      results: results.map((r) => ({
        id: r.id,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        entity_name: r.entity_name,
        field: r.field,
        lang: r.lang,
        outcome: r.outcome,
        status: r.status,
        attempts: r.attempts,
        reason: r.reason ?? null,
        review: r.review ? { verdict: r.review.verdict, fidelity: r.review.fidelity, fluency: r.review.fluency, issues: r.review.issues, summary: r.review.summary } : null,
        verify_failed: r.verify ? r.verify.failed : null,
      })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── GET /collect (session lane) ──────────────────────────────────────────
router.get("/collect", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const platform = parsePlatform(req.query.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const langs = parseLangs(req.query.langs);
  if (!langs) return res.status(400).json({ error: "langs må være en liste av en/sv" });
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(PROFILE_TRANSLATIONS_COLLECT_MAX_ITEMS, Math.floor(limitRaw))
    : PROFILE_TRANSLATIONS_COLLECT_DEFAULT_ITEMS;
  const entityIdsRaw = req.query.entity_ids;
  const entityIds = entityIdsRaw
    ? String(Array.isArray(entityIdsRaw) ? entityIdsRaw.join(",") : entityIdsRaw).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500)
    : undefined;
  const lockHolder = `admin-session-${platform}`;
  if (!tryAcquireTranslationRunLock(lockHolder)) {
    return res.status(409).json({ error: "busy", note: "workeren eller en annen kjøring holder låsen — prøv igjen senere", lock: getWorkerState().lock });
  }
  try {
    const batchId = batchIdFor(`col-${platform}`);
    const r = collectForSession(dbFor(platform), platform, langs, limit, { entityIds, batchId, actor: String(req.query.actor || "session").slice(0, 80) });
    return res.json({ platform, langs, limit, batch_id: batchId, flags: flagsSnapshot(), items_count: r.items.length, remaining_after_this_batch: r.remaining_actionable, skipped: r.skipped, pairs_total: r.total_pairs, instructions: r.instructions, items: r.items });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  } finally {
    releaseTranslationRunLock(lockHolder);
  }
});

// ── POST /submit (session lane) ──────────────────────────────────────────
router.post("/submit", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;
  const platform = parsePlatform(body.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  if (!Array.isArray(body.items) || body.items.length === 0) return res.status(400).json({ error: "items må være en ikke-tom liste" });
  if (body.items.length > PROFILE_TRANSLATIONS_SUBMIT_MAX_ITEMS) return res.status(400).json({ error: `maks ${PROFILE_TRANSLATIONS_SUBMIT_MAX_ITEMS} items per kall` });
  const actor = String(body.actor || "session").slice(0, 80);
  const subs: SessionSubmission[] = [];
  for (const it of body.items) {
    const id = Number(it?.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "hvert item trenger et positivt heltall som id" });
    if (typeof it.translated_text !== "string") return res.status(400).json({ error: `item ${id}: translated_text må være en streng` });
    if (!it.review || typeof it.review !== "object") return res.status(400).json({ error: `item ${id}: review (uavhengig verdikt) er påkrevd` });
    subs.push({ id, source_hash: it.source_hash ? String(it.source_hash) : null, translated_text: it.translated_text, already_target_language: it.already_target_language === true, kept_terms: Array.isArray(it.kept_terms) ? it.kept_terms : [], notes: it.notes ? String(it.notes) : "", review: it.review });
  }
  const lockHolder = `admin-session-${platform}`;
  if (!tryAcquireTranslationRunLock(lockHolder)) {
    return res.status(409).json({ error: "busy", note: "workeren eller en annen kjøring holder låsen — prøv igjen senere", lock: getWorkerState().lock });
  }
  try {
    const batchId = batchIdFor(`sub-${platform}`);
    const db = dbFor(platform);
    const results = subs.map((sub) => submitSessionTranslation(db, platform, sub, { actor, batchId, translatorLabel: body.translator_label ? String(body.translator_label).slice(0, 80) : undefined, reviewerLabel: body.reviewer_label ? String(body.reviewer_label).slice(0, 80) : undefined }));
    const outcomes: Record<string, number> = {};
    for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    return res.json({ platform, batch_id: batchId, count: results.length, outcomes, results });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  } finally {
    releaseTranslationRunLock(lockHolder);
  }
});

// ── POST /sweep-stale ────────────────────────────────────────────────────
router.post("/sweep-stale", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;
  const platform = parsePlatform(body.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const dryRun = strictDryRun(body);
  const limitRaw = Number(body.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
  try {
    const r = sweepStaleTranslations(dbFor(platform), platform, { dryRun, batchId: batchIdFor(`stale-${platform}`), actor: String(body.actor || "stale-sweep").slice(0, 80), limit });
    return res.json({ platform, dry_run: dryRun, ...r });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── POST /publish ────────────────────────────────────────────────────────
router.post("/publish", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;
  const platform = parsePlatform(body.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const lang = parseLang(body.lang);
  if (!lang) return res.status(400).json({ error: "lang må være en eller sv" });
  const ids = parseIds(body.ids);
  if (ids === null) return res.status(400).json({ error: "ids må være en liste av positive heltall" });
  const dryRun = strictDryRun(body);
  try {
    const r = publishVerified(dbFor(platform), platform, lang, { ids: ids || undefined, dryRun, batchId: batchIdFor(`pub-${platform}-${lang}`), actor: "admin" });
    return res.json({ platform, lang, dry_run: dryRun, serve_enabled: isProfileTranslationServingEnabled(), ...r });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── POST /unpublish ──────────────────────────────────────────────────────
router.post("/unpublish", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;
  const platform = parsePlatform(body.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const lang = parseLang(body.lang);
  if (!lang) return res.status(400).json({ error: "lang må være en eller sv" });
  const ids = parseIds(body.ids);
  if (ids === null) return res.status(400).json({ error: "ids må være en liste av positive heltall" });
  try {
    const r = unpublish(dbFor(platform), platform, lang, { ids: ids || undefined, batchId: batchIdFor(`unpub-${platform}-${lang}`), actor: "admin", reason: body.reason ? String(body.reason).slice(0, 500) : undefined });
    return res.json({ platform, lang, ...r });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── POST /reject ─────────────────────────────────────────────────────────
router.post("/reject", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;
  const platform = parsePlatform(body.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "id må være et positivt heltall" });
  const reason = String(body.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason er påkrevd" });
  try {
    const row = rejectTranslation(dbFor(platform), id, reason, String(body.actor || "admin").slice(0, 80));
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json({ platform, id, status: row.status, reject_reason: row.reject_reason });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ── POST /requeue ────────────────────────────────────────────────────────
router.post("/requeue", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;
  const platform = parsePlatform(body.platform);
  if (!platform) return res.status(400).json({ error: "platform må være rfb eller opplevagent" });
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "id må være et positivt heltall" });
  try {
    const row = requeueTranslation(dbFor(platform), id, String(body.actor || "admin").slice(0, 80));
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json({ platform, id, status: row.status, attempts: row.attempts });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/** undefined = not given; null = invalid; number[] = valid list */
function parseIds(raw: unknown): number[] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    out.push(n);
  }
  return out;
}

export default router;
