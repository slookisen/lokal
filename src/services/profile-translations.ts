/**
 * profile-translations.ts — dev-request
 * 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent (Daniel, live session
 * 2026-09-02): the shared "rullebånd" (conveyor belt) that turns Norwegian
 * profile prose on BOTH platforms — Rett fra Bonden producer profiles and
 * opplevagent experience / gårdssalg-producer profiles — into reviewed,
 * verified English and Swedish text, WITHOUT ever touching the Norwegian
 * source columns and WITHOUT showing anything publicly until a whole batch
 * ("pulje") is explicitly published AND the serving flag is on.
 *
 * Pipeline per (entity, field, language) item — every stage is recorded:
 *
 *   collect  → pick prose fields from the platform's public rows (only rows
 *              that are visible today: RFB active producers, opplevagent
 *              published experiences / catalog-visible gårdssalg producers),
 *              hash the source, upsert a `draft` row. A changed source hash
 *              supersedes the old translation (status reset → `draft`, the
 *              old text kept in prev_translated_text, audit row written) so a
 *              translation can never drift away from the Norwegian it claims
 *              to translate.
 *   translate → LLM call #1 (PROFILE_TRANSLATION_MODEL, default claude-opus-5):
 *              a professional-translator prompt with a fixed domain glossary.
 *              Output is JSON {translation, already_target_language, notes}.
 *   review    → LLM call #2 (PROFILE_TRANSLATION_REVIEW_MODEL, default
 *              claude-opus-5), a FRESH context with a different role (senior
 *              reviewer): fidelity + fluency scores 1-5, typed issues, verdict
 *              APPROVE | REVISE | REJECT. The reviewer's own suggested text is
 *              never adopted directly (proposer ≠ admitter): a REVISE verdict
 *              feeds the issues back into ONE more translator round, which is
 *              then reviewed again. Anything short of APPROVE after that →
 *              `rejected` (manual queue, never auto-published).
 *   verify    → verifyTranslationDeterministic(): pure, no LLM — non-empty, no
 *              markup, sane length ratio, every digit-run / URL / e-mail of
 *              the source preserved, not a verbatim copy, no un-translated
 *              Norwegian words (any æ/ø/å-word in the target must already
 *              occur in the source, i.e. be a preserved proper noun).
 *              Passing → `verified`; failing → `rejected` with the failed
 *              check names as the reason.
 *   publish   → explicit admin action (POST /admin/profile-translations/
 *              publish) flips `verified` → `published` for a language/
 *              platform (whole pulje or listed ids). This is Daniel's
 *              «rull ut hele puljen til slutt» step.
 *   serve     → getPublishedProfileTranslations() is what the SSR routes call;
 *              it returns {} unless PROFILE_TRANSLATIONS_SERVE_ENABLED ===
 *              "true" (read fresh per call), so with the flag off every page
 *              renders byte-identically to before this dev-request.
 *
 * Fail-closed contract (same as the judge modules): missing ANTHROPIC_API_KEY,
 * network failure, non-200, refusal, truncated output or unparseable JSON
 * never fabricates text — the item stays `draft` (retryable) with the error
 * in translator_notes/reject_reason, and nothing is ever published by the
 * pipeline itself.
 *
 * Both SQLite files (rfb: database/init.ts, experiences: database/
 * init-experiences.ts) get the SAME two tables via ensureProfileTranslationsSchema()
 * so each platform's translations live next to the rows they translate.
 *
 * Layering: services/ never imports from routes/. The opplevagent publish
 * gate is inlined as OPPLEVAGENT_PUBLISH_GATE_SQL and a test asserts it stays
 * byte-equal to experience-store.ts's exported PUBLISH_GATE_SQL (drift guard).
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { isJunkDescription, looksTruncatedMidWord } from "./description-quality";

// ─── Types ───────────────────────────────────────────────────────────────

export type TranslationPlatform = "rfb" | "opplevagent";
export type TranslationTargetLang = "en" | "sv";
export type TranslationStatus = "draft" | "reviewed" | "verified" | "published" | "rejected";
export type TranslationFieldKind = "title" | "prose" | "hours";

export const TRANSLATION_PLATFORMS: TranslationPlatform[] = ["rfb", "opplevagent"];
export const TRANSLATION_TARGET_LANGS: TranslationTargetLang[] = ["en", "sv"];

export interface TranslationFieldSpec {
  entity_type: string;
  field: string;
  kind: TranslationFieldKind;
}

/** Which prose columns each platform translates. Single words / enum-ish
 *  columns (categories, tags, product name lists) are deliberately NOT here —
 *  those are UI-dictionary territory (src/i18n/locales/*.json). */
export const PROFILE_TRANSLATION_FIELDS: Record<TranslationPlatform, TranslationFieldSpec[]> = {
  rfb: [
    { entity_type: "agent", field: "description", kind: "prose" },
    { entity_type: "agent", field: "about", kind: "prose" },
  ],
  opplevagent: [
    { entity_type: "experience", field: "title", kind: "title" },
    { entity_type: "experience", field: "description", kind: "prose" },
    { entity_type: "experience", field: "meeting_point", kind: "prose" },
    { entity_type: "provider", field: "about_text", kind: "prose" },
    { entity_type: "provider", field: "visit_text", kind: "prose" },
    { entity_type: "provider", field: "opening_hours_text", kind: "hours" },
  ],
};

export interface SourceItem {
  entity_type: string;
  entity_id: string;
  entity_name: string;
  field: string;
  kind: TranslationFieldKind;
  text: string;
}

export interface TranslationRow {
  id: number;
  platform: TranslationPlatform;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  field: string;
  lang: TranslationTargetLang;
  source_text: string;
  source_hash: string;
  translated_text: string | null;
  prev_translated_text: string | null;
  status: TranslationStatus;
  attempts: number;
  translator_model: string | null;
  reviewer_model: string | null;
  translator_notes: string | null;
  review_json: string | null;
  verify_json: string | null;
  reject_reason: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  verified_at: string | null;
  published_at: string | null;
}

// ─── Flags (read fresh per call — fly.toml flip takes effect immediately) ──

/** LLM spend switch for the pipeline (`POST /admin/profile-translations/run`). */
export function isProfileTranslationPipelineEnabled(): boolean {
  return process.env.PROFILE_TRANSLATIONS_ENABLED === "true";
}

/** Public-rendering switch: published rows are served on /en and /sv pages
 *  ONLY while this is "true". Off = every page byte-identical to before. */
export function isProfileTranslationServingEnabled(): boolean {
  return process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED === "true";
}

export const DEFAULT_TRANSLATOR_MODEL = "claude-opus-5";
export const DEFAULT_REVIEWER_MODEL = "claude-opus-5";
export function translatorModel(): string {
  return (process.env.PROFILE_TRANSLATION_MODEL || "").trim() || DEFAULT_TRANSLATOR_MODEL;
}
export function reviewerModel(): string {
  return (process.env.PROFILE_TRANSLATION_REVIEW_MODEL || "").trim() || DEFAULT_REVIEWER_MODEL;
}

/** Translator rounds per item before it lands in the manual `rejected` queue. */
export const MAX_TRANSLATION_ATTEMPTS = 2;
/**
 * LLM-call failures that say nothing about the item itself (no key, network,
 * HTTP 4xx/5xx such as "credit balance is too low"). They never consume one of
 * the item's MAX_TRANSLATION_ATTEMPTS — the worker backs off instead — so a
 * billing outage cannot park half the catalogue in `max_attempts`.
 */
export const LLM_INFRA_REASON_RE = /ANTHROPIC_API_KEY|nettverksfeil|status [45]\d\d/;

// ─── Schema ──────────────────────────────────────────────────────────────

export function ensureProfileTranslationsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_translations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      field TEXT NOT NULL,
      lang TEXT NOT NULL,
      source_text TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      translated_text TEXT,
      prev_translated_text TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      attempts INTEGER NOT NULL DEFAULT 0,
      translator_model TEXT,
      reviewer_model TEXT,
      translator_notes TEXT,
      review_json TEXT,
      verify_json TEXT,
      reject_reason TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      verified_at TEXT,
      published_at TEXT,
      UNIQUE(platform, entity_type, entity_id, field, lang)
    );
    CREATE INDEX IF NOT EXISTS idx_profile_translations_status
      ON profile_translations(platform, lang, status);
    CREATE INDEX IF NOT EXISTS idx_profile_translations_entity
      ON profile_translations(platform, entity_type, entity_id, lang);
    CREATE TABLE IF NOT EXISTS profile_translation_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      translation_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT,
      batch_id TEXT,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_profile_translation_audit_tid
      ON profile_translation_audit(translation_id);
  `);
}

// ─── Source collection ───────────────────────────────────────────────────

/** Inlined copy of experience-store.ts's PUBLISH_GATE_SQL (services/ must not
 *  grow a dependency on that 9k-line module for one predicate). A unit test
 *  asserts the two strings are byte-equal so they cannot drift apart. */
export const OPPLEVAGENT_PUBLISH_GATE_SQL =
  "e.verification_status = 'verified' " +
  "AND (e.confidence IS NULL OR e.confidence IN ('high','medium')) " +
  "AND (p.id IS NULL OR p.brreg_active = 1) " +
  "AND e.canonical_id IS NULL";

function cleanSource(text: unknown): string {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

/** True when a source value is worth translating at all: non-empty, not
 *  scraped nav junk, not a mid-word truncated scrape slice. Mirrors the
 *  render-time guards the public pages already apply, so we never spend LLM
 *  budget on text the page would suppress anyway. */
export function isTranslatableSource(text: string, kind: TranslationFieldKind): boolean {
  const t = cleanSource(text);
  if (!t) return false;
  if (kind === "title") return t.length >= 2 && t.length <= 300;
  if (t.length < 2) return false;
  if (isJunkDescription(t)) return false;
  if (looksTruncatedMidWord(t)) return false;
  return true;
}

function pushIf(items: SourceItem[], spec: TranslationFieldSpec, entityId: string, entityName: string, raw: unknown): void {
  const text = cleanSource(raw);
  if (!isTranslatableSource(text, spec.kind)) return;
  items.push({ entity_type: spec.entity_type, entity_id: entityId, entity_name: entityName, field: spec.field, kind: spec.kind, text });
}

/**
 * Enumerate every translatable (entity, field) on a platform from its OWN
 * database handle. Only rows that are publicly visible today are included —
 * a hidden/unpublished row must not gain a translation before it gains a
 * Norwegian page.
 */
export function collectSourceItems(
  db: Database.Database,
  platform: TranslationPlatform,
  opts: { entityIds?: string[] } = {},
): SourceItem[] {
  const items: SourceItem[] = [];
  const idFilter = (opts.entityIds || []).map((s) => String(s)).filter(Boolean);
  const idSet = idFilter.length ? new Set(idFilter) : null;

  if (platform === "rfb") {
    const specs = PROFILE_TRANSLATION_FIELDS.rfb;
    const rows = db
      .prepare(
        `SELECT a.id AS id, a.name AS name, a.description AS description, k.about AS about
           FROM agents a
           LEFT JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.is_active = 1 AND a.role = 'producer'
          ORDER BY a.id`,
      )
      .all() as Array<{ id: string; name: string; description: string | null; about: string | null }>;
    for (const r of rows) {
      if (idSet && !idSet.has(String(r.id))) continue;
      for (const spec of specs) {
        pushIf(items, spec, String(r.id), String(r.name || ""), (r as any)[spec.field]);
      }
    }
    return items;
  }

  // opplevagent — experiences (published set only) + gårdssalg providers
  // (catalog-visible set only, same predicate as getGardssalgProviderBySlug).
  const expSpecs = PROFILE_TRANSLATION_FIELDS.opplevagent.filter((s) => s.entity_type === "experience");
  const provSpecs = PROFILE_TRANSLATION_FIELDS.opplevagent.filter((s) => s.entity_type === "provider");
  const expRows = db
    .prepare(
      `SELECT e.id AS id, e.title AS title, e.title_no AS title_no, e.description AS description,
              e.meeting_point AS meeting_point
         FROM experiences e
         LEFT JOIN experience_providers p ON p.id = e.provider_id
        WHERE ${OPPLEVAGENT_PUBLISH_GATE_SQL}
        ORDER BY e.id`,
    )
    .all() as Array<{ id: string; title: string; title_no: string | null; description: string | null; meeting_point: string | null }>;
  for (const r of expRows) {
    if (idSet && !idSet.has(String(r.id))) continue;
    const displayTitle = cleanSource(r.title_no) || cleanSource(r.title);
    for (const spec of expSpecs) {
      // The Norwegian display title (title_no when backfilled) is the source
      // for the "title" field — that is what the NO page shows as <h1>.
      const raw = spec.field === "title" ? displayTitle : (r as any)[spec.field];
      pushIf(items, spec, String(r.id), displayTitle, raw);
    }
  }
  const provRows = db
    .prepare(
      `SELECT id, navn, about_text, visit_text, opening_hours_text
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
        ORDER BY id`,
    )
    .all() as Array<{ id: string; navn: string; about_text: string | null; visit_text: string | null; opening_hours_text: string | null }>;
  for (const r of provRows) {
    if (idSet && !idSet.has(String(r.id))) continue;
    for (const spec of provSpecs) {
      pushIf(items, spec, String(r.id), String(r.navn || ""), (r as any)[spec.field]);
    }
  }
  return items;
}

export function sourceHash(text: string): string {
  return createHash("sha256").update(cleanSource(text).replace(/\s+/g, " ")).digest("hex").slice(0, 32);
}

// ─── Store helpers ───────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

export function getTranslationRow(
  db: Database.Database,
  key: { platform: TranslationPlatform; entity_type: string; entity_id: string; field: string; lang: TranslationTargetLang },
): TranslationRow | null {
  const row = db
    .prepare(
      `SELECT * FROM profile_translations
        WHERE platform = ? AND entity_type = ? AND entity_id = ? AND field = ? AND lang = ?`,
    )
    .get(key.platform, key.entity_type, key.entity_id, key.field, key.lang) as TranslationRow | undefined;
  return row ?? null;
}

export function getTranslationById(db: Database.Database, id: number): TranslationRow | null {
  const row = db.prepare(`SELECT * FROM profile_translations WHERE id = ?`).get(id) as TranslationRow | undefined;
  return row ?? null;
}

function audit(
  db: Database.Database,
  translationId: number,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  note: string | null,
  batchId: string | null,
): void {
  db.prepare(
    `INSERT INTO profile_translation_audit (translation_id, from_status, to_status, actor, note, batch_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(translationId, fromStatus, toStatus, actor, note, batchId, nowIso());
}

function setStatus(
  db: Database.Database,
  row: TranslationRow,
  toStatus: TranslationStatus,
  patch: Partial<Record<keyof TranslationRow, unknown>>,
  actor: string,
  note: string | null,
  batchId: string | null,
): TranslationRow {
  const cols: string[] = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [toStatus, nowIso()];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = ?`);
    vals.push(v as any);
  }
  vals.push(row.id);
  db.prepare(`UPDATE profile_translations SET ${cols.join(", ")} WHERE id = ?`).run(...(vals as any[]));
  audit(db, row.id, row.status, toStatus, actor, note, batchId);
  return getTranslationById(db, row.id)!;
}

export type PlanDecision =
  | { action: "new" }
  | { action: "retry"; attempts: number }
  | { action: "source_changed"; previous_status: TranslationStatus }
  | { action: "skip"; reason: "up_to_date" | "rejected_manual_queue" | "max_attempts" };

/** Decide what the pipeline should do with one (item, lang) pair. Pure. */
export function planItem(existing: TranslationRow | null, hash: string): PlanDecision {
  if (!existing) return { action: "new" };
  if (existing.source_hash !== hash) return { action: "source_changed", previous_status: existing.status };
  if (existing.status === "verified" || existing.status === "published" || existing.status === "reviewed") {
    return { action: "skip", reason: "up_to_date" };
  }
  if (existing.status === "rejected") return { action: "skip", reason: "rejected_manual_queue" };
  // draft
  if (existing.attempts >= MAX_TRANSLATION_ATTEMPTS) return { action: "skip", reason: "max_attempts" };
  return { action: "retry", attempts: existing.attempts };
}

export interface PlannedItem {
  item: SourceItem;
  lang: TranslationTargetLang;
  hash: string;
  decision: PlanDecision;
}

/**
 * Plan a batch: every translatable (item × lang) with its decision. `limit`
 * caps the number of ACTIONABLE items (new/retry/source_changed) returned;
 * skipped items are counted in `skipped` so the caller can report coverage.
 */
/**
 * Source text that is not a profile text at all: pipeline metadata ("Oppdaget
 * via brreg-nace-discovery"), scraped JavaScript, or a scraped navigation menu
 * (many capitalised fragments, no sentence punctuation). Translating it wastes
 * two LLM calls and the reviewer rejects it anyway; the planner skips it as
 * `source_junk` so the routine can report the count as a data-quality finding.
 */
export function isJunkSource(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^oppdaget via\b/i.test(t)) return true;
  if (/\bfunction\s*\(|window\.|document\.|\{[^}]*\}\s*;?|<\/?[a-z][^>]*>/i.test(t)) return true;
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length >= 12 && !/[.!?…]/.test(t)) {
    const capitalised = tokens.filter((w) => /^[A-ZÆØÅ]/.test(w)).length;
    if (capitalised / tokens.length >= 0.5) return true;
  }
  if (/\b(handlekurv|nettbutikk|logg inn|min side)\b/i.test(t) && tokens.length >= 8 && !/[.!?]/.test(t)) return true;
  return false;
}

export function planTranslationBatch(
  db: Database.Database,
  platform: TranslationPlatform,
  langs: TranslationTargetLang[],
  limit: number,
  opts: { entityIds?: string[] } = {},
): { actionable: PlannedItem[]; skipped: Record<string, number>; total_pairs: number; remaining_actionable: number } {
  const items = collectSourceItems(db, platform, opts);
  const actionable: PlannedItem[] = [];
  const skipped: Record<string, number> = {};
  let totalPairs = 0;
  let remaining = 0;
  for (const item of items) {
    const junk = isJunkSource(item.text);
    for (const lang of langs) {
      totalPairs++;
      if (junk) {
        skipped.source_junk = (skipped.source_junk || 0) + 1;
        continue;
      }
      const hash = sourceHash(item.text);
      const existing = getTranslationRow(db, { platform, entity_type: item.entity_type, entity_id: item.entity_id, field: item.field, lang });
      const decision = planItem(existing, hash);
      if (decision.action === "skip") {
        skipped[decision.reason] = (skipped[decision.reason] || 0) + 1;
        continue;
      }
      if (actionable.length < limit) actionable.push({ item, lang, hash, decision });
      else remaining++;
    }
  }
  return { actionable, skipped, total_pairs: totalPairs, remaining_actionable: remaining };
}

/** Upsert the draft row for a planned item (records a superseded source). */
export function upsertDraft(db: Database.Database, platform: TranslationPlatform, p: PlannedItem, batchId: string): TranslationRow {
  const key = { platform, entity_type: p.item.entity_type, entity_id: p.item.entity_id, field: p.item.field, lang: p.lang };
  const existing = getTranslationRow(db, key);
  if (!existing) {
    db.prepare(
      `INSERT INTO profile_translations
         (platform, entity_type, entity_id, entity_name, field, lang, source_text, source_hash, status, attempts, batch_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?)`,
    ).run(platform, key.entity_type, key.entity_id, p.item.entity_name, key.field, key.lang, p.item.text, p.hash, batchId, nowIso(), nowIso());
    const row = getTranslationRow(db, key)!;
    audit(db, row.id, null, "draft", "pipeline", "collected", batchId);
    return row;
  }
  if (p.decision.action === "source_changed") {
    return setStatus(
      db,
      existing,
      "draft",
      {
        source_text: p.item.text,
        source_hash: p.hash,
        entity_name: p.item.entity_name,
        prev_translated_text: existing.translated_text,
        translated_text: null,
        attempts: 0,
        review_json: null,
        verify_json: null,
        reject_reason: null,
        reviewed_at: null,
        verified_at: null,
        published_at: null,
        batch_id: batchId,
      },
      "pipeline",
      `source changed (was ${existing.source_hash}, status ${existing.status})`,
      batchId,
    );
  }
  return existing;
}

// ─── Deterministic verification (pure) ───────────────────────────────────

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  failed: string[];
}

/** Lowercase Norwegian function words that can never be a word of the
 *  target language. Deliberately short and unambiguous — "i" is fine because
 *  English "I" is always capitalised; "med"/"på"/"i" are left out of the
 *  Swedish list because Swedish uses them too. */
export const NORWEGIAN_STOPWORDS_NOT_ENGLISH = new Set([
  "i", "og", "til", "fra", "ved", "hos", "med", "av", "om", "eller", "som", "det", "den", "er", "har", "ikke", "også", "når", "hvor", "hva",
]);
/** Everyday Norwegian words a translator may never "keep" via kept_terms. */
export const KEPT_TERM_DENYLIST = new Set([
  "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag", "mandager", "tirsdager", "onsdager", "torsdager", "fredager", "lørdager", "søndager",
  "åpent", "åpen", "åpne", "åpningstid", "åpningstider", "stengt", "økologisk", "økologiske", "gård", "gården", "gårder", "gårdsbutikk", "gårdsbutikken", "gårdsutsalg",
  "år", "året", "måned", "måneden", "uke", "uken", "hver", "alle", "både", "også", "når", "hvor", "hvordan", "kjøtt", "brød", "smør", "ost", "øl", "låve", "låven",
  "sør", "nord", "øst", "vest", "høst", "vår", "sommer", "vinter", "påske", "jul", "første", "nå", "så", "på", "får", "går", "må", "frå", "lørdagsåpent", "søndagsåpent",
]);
/** County / region names whose "og" is part of the name. */
export const KNOWN_NAME_PHRASES = new Set(["sogn og fjordane", "møre og romsdal", "vestfold og telemark", "troms og finnmark", "aust og vest"]);
/** Source phrases that introduce a network/organisation name right after them. */
const NAME_MARKER_RE = /(del av|medlem av|medlem i|tilknyttet|nettverket|samvirket|merkevaren|kjeden|i regi av|gjennom)\b[^.!?]{0,40}$/i;

export const NORWEGIAN_STOPWORDS_NOT_SWEDISH = new Set([
  "og", "til", "fra", "ved", "hos", "ikke", "også", "når", "hvor", "hva", "hvordan", "noen", "mye", "bare", "nå",
]);

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const DIGIT_RUN_RE = /\d+/g;
/** Ordinal written with digits in Norwegian prose: "6. generasjon", "3. søndag". */
const NB_ORDINAL_RE = /\b(\d{1,2})\.\s+(?=[a-zæøå])/gi;
const ORDINAL_WORDS: Record<TranslationTargetLang, string[]> = {
  en: ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"],
  sv: ["", "första", "andra", "tredje", "fjärde", "femte", "sjätte", "sjunde", "åttonde", "nionde", "tionde", "elfte", "tolfte", "trettonde", "fjortonde", "femtonde", "sextonde", "sjuttonde", "artonde", "nittonde", "tjugonde"],
};
/**
 * A digit-run missing from the translation is tolerated when the source used it
 * as an ordinal ("6. generasjon") and the translation spells that ordinal out
 * ("sixth generation" / "sjätte generationen"). Everything else stays strict.
 */
/**
 * "1600-tallet" is idiomatically "the 1600s" or "the 17th century" in English;
 * tolerate either. Swedish keeps "1600-talet", so nothing to tolerate there.
 */
export function centurySpelledOut(src: string, out: string, digits: string, lang: TranslationTargetLang): boolean {
  if (!/^\d{2}00$/.test(digits) || !new RegExp(`\\b${digits}-tall`, "i").test(src)) return false;
  if (lang !== "en") return false;
  const century = Number(digits.slice(0, 2)) + 1;
  const suffix = century % 10 === 1 && century !== 11 ? "st" : century % 10 === 2 && century !== 12 ? "nd" : century % 10 === 3 && century !== 13 ? "rd" : "th";
  return new RegExp(`\\b${digits}s\\b`).test(out) || new RegExp(`\\b${century}${suffix}[ -]century\\b`, "i").test(out);
}

export function ordinalSpelledOut(src: string, out: string, digits: string, lang: TranslationTargetLang): boolean {
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 1 || n > 20) return false;
  const usedAsOrdinal = Array.from(src.matchAll(NB_ORDINAL_RE)).some((m) => Number(m[1]) === n);
  if (!usedAsOrdinal) return false;
  const word = ORDINAL_WORDS[lang][n];
  return new RegExp(`(^|[^a-zäöåæø])${word}([^a-zäöåæø]|$)`, "i").test(out);
}

function multiset(arr: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of arr) m.set(a, (m.get(a) || 0) + 1);
  return m;
}
/** Every missing occurrence, repeated per count ("1600" twice in the source, once in the output → one entry). */
function multisetDiff(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of a) {
    const have = b.get(k) || 0;
    for (let i = have; i < n; i++) out.push(k);
  }
  return out;
}

/**
 * Deterministic, LLM-free checks a translation must pass before it can be
 * `verified`. Conservative on purpose: a false rejection costs one manual
 * look, a false acceptance publishes a wrong text under the producer's name.
 */
export function verifyTranslationDeterministic(
  source: string,
  translated: string,
  lang: TranslationTargetLang,
  opts: { kind?: TranslationFieldKind; alreadyTargetLanguage?: boolean; entityName?: string | null; keptTerms?: string[] | null } = {},
): VerifyResult {
  const src = cleanSource(source);
  const out = cleanSource(translated);
  const checks: VerifyCheck[] = [];
  const kind = opts.kind || "prose";

  checks.push({ name: "non_empty", ok: out.length > 0 });

  const hasMarkup = /<[a-z!/][^>]*>/i.test(out) || /```/.test(out) || /^\s*(translation|oversettelse|översättning)\s*:/i.test(out);
  checks.push({ name: "no_markup", ok: !hasMarkup });

  const ratio = src.length ? out.length / src.length : 0;
  const short = src.length < 40;
  const ratioOk = short ? ratio >= 0.3 && ratio <= 4 : ratio >= 0.45 && ratio <= 2.4;
  checks.push({ name: "length_ratio", ok: ratioOk, detail: ratio.toFixed(2) });

  const srcDigits = multiset(src.match(DIGIT_RUN_RE) || []);
  const outDigits = multiset(out.match(DIGIT_RUN_RE) || []);
  // A spelled-out ordinal/century idiom excuses exactly ONE missing occurrence
  // of its digit-run; a second missing "1600" (e.g. an altitude) still fails.
  const idiomUsed = new Set<string>();
  const missingDigits = multisetDiff(srcDigits, outDigits).filter((d) => {
    if (idiomUsed.has(d)) return true;
    if (ordinalSpelledOut(src, out, d, lang) || centurySpelledOut(src, out, d, lang)) {
      idiomUsed.add(d);
      return false;
    }
    return true;
  });
  checks.push({ name: "digits_preserved", ok: missingDigits.length === 0, detail: missingDigits.slice(0, 5).join(",") || undefined });

  const srcUrls = (src.match(URL_RE) || []).map((u) => u.replace(/[.,;:]+$/, ""));
  const missingUrls = srcUrls.filter((u) => !out.includes(u));
  checks.push({ name: "urls_preserved", ok: missingUrls.length === 0, detail: missingUrls.slice(0, 3).join(" ") || undefined });

  const srcEmails = (src.match(EMAIL_RE) || []).map((e) => e.toLowerCase());
  const outLower = out.toLowerCase();
  const missingEmails = srcEmails.filter((e) => !outLower.includes(e));
  checks.push({ name: "emails_preserved", ok: missingEmails.length === 0, detail: missingEmails.slice(0, 3).join(" ") || undefined });

  // Norwegian and Swedish are close enough that a short title can be
  // letter-for-letter identical in both ("Lysefjorden fjordcruise med
  // elektrisk katamaran", "Norsk Oljemuseum i Stavanger" — both rejected live
  // 2026-09-02 as verbatim copies although the Swedish IS that text). For sv
  // an identical output is therefore accepted up to 8 words; English never
  // shares a whole sentence with Norwegian, so the 4-word rule stays there.
  const srcWords = src.split(/\s+/).filter(Boolean);
  const identical = src.replace(/\s+/g, " ").toLowerCase() === out.replace(/\s+/g, " ").toLowerCase();
  const identicalWordCap = lang === "sv" ? 8 : 4;
  // "Museum Nord – Vesterålen og Lofoten": a title made only of capitalised
  // words (plus og/av/fra between them, digits and dashes) is a proper name
  // and is correctly identical in the target language.
  const titleTokens = out.split(/[\s.,;:!?()"'«»–—/]+/).filter(Boolean);
  const allProperNounTitle =
    kind === "title" &&
    titleTokens.length > 0 &&
    titleTokens.length <= 12 &&
    titleTokens.every((w, i) => /^[A-ZÆØÅ0-9]/.test(w) || (["og", "av", "fra"].includes(w) && i > 0 && i < titleTokens.length - 1));
  const identicalOk = !identical || srcWords.length <= identicalWordCap || opts.alreadyTargetLanguage === true || allProperNounTitle;
  checks.push({ name: "not_verbatim_copy", ok: identicalOk });

  // Un-translated Norwegian: any word carrying æ/ø (and, for English, å) in
  // the output is only acceptable when it is a preserved proper noun — i.e.
  // it occurs in the source with an initial CAPITAL letter (Rørosmeieriet,
  // Bø, Ålesund) or is part of the entity's own name. A lowercase æ/ø/å word
  // (lørdager, åpent, økologisk) is Norwegian that slipped through, even
  // though it of course also occurs in the source. Swedish legitimately uses
  // å, so only æ/ø are checked for sv. Punctuation is stripped first.
  const nordicRe = lang === "sv" ? /[æøÆØ]/ : /[æøåÆØÅ]/;
  const splitRe = /[\s.,;:!?()"'«»–—/]+/;
  const srcCapitalized = new Set(src.split(splitRe).filter((w) => w && /^[A-ZÆØÅ]/.test(w)));
  // Proper nouns also survive with a Norwegian suffix or genitive in the
  // source ("Tromsø-fjordene" → "Tromsø Fjords", "Jærens" → "Jæren's"): a
  // capitalised output word that is a prefix (≥ 4 chars) of a capitalised
  // source token — hyphen-split as well — is a preserved name. Sentence-
  // initial source tokens do not count: "Gården ligger…" is a common noun
  // that is capitalised only by position, and its stem ("Gård") must not
  // become a licensed prefix. Proper nouns are capitalised everywhere.
  const srcWs = src.split(/\s+/).filter(Boolean);
  const srcCapitalizedParts = new Set<string>();
  srcWs.forEach((tok, idx) => {
    const sentenceInitial = idx === 0 || /[.!?:]$/.test(srcWs[idx - 1]);
    if (sentenceInitial) return;
    for (const part of tok.split(/[\s.,;:!?()"'«»–—/-]+/)) if (part && /^[A-ZÆØÅ]/.test(part)) srcCapitalizedParts.add(part);
  });
  const isNamePrefix = (w: string): boolean => /^[A-ZÆØÅ]/.test(w) && w.length >= 4 && Array.from(srcCapitalizedParts).some((t) => t.startsWith(w));
  const nameWords = new Set(String(opts.entityName || "").toLowerCase().split(splitRe).filter(Boolean));
  // Terms the translator declared it kept on purpose (dish names, "mål") are
  // tolerated only with deterministic evidence of intent: the term occurs in
  // the source, is not an everyday Norwegian word, and appears in the output
  // followed by a parenthetical gloss at least once ("rømmegrøt (sour cream
  // porridge)"). At most 4 per field. The LLM reviewer is shown the same list
  // and judges whether keeping them was right.
  const srcLowerWords = new Set(src.toLowerCase().split(splitRe).filter(Boolean));
  const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasGloss = (t: string): boolean => new RegExp(`(^|[^\\p{L}])${escapeRe(t)}\\s*\\(`, "iu").test(out);
  const declared = (Array.isArray(opts.keptTerms) ? opts.keptTerms : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const keptTerms = new Set(declared.slice(0, 4).filter((t) => srcLowerWords.has(t) && !KEPT_TERM_DENYLIST.has(t) && hasGloss(t)));
  const leaked = out
    .split(splitRe)
    .filter((w) => w && nordicRe.test(w))
    .filter((w) => !srcCapitalized.has(w) && !nameWords.has(w.toLowerCase()) && !keptTerms.has(w.toLowerCase()) && !isNamePrefix(w));
  const leakedUnique = Array.from(new Set(leaked));
  checks.push({
    name: "no_untranslated_norwegian",
    ok: leakedUnique.length === 0,
    detail: leakedUnique.length ? leakedUnique.slice(0, 5).join(",") : keptTerms.size ? `kept:${Array.from(keptTerms).join(",")}` : undefined,
  });

  // Un-translated Norwegian function words (no æ/ø/å, so the check above
  // cannot see them): "Nordlandsmuseet i Bodø" left as-is in English, "og"/
  // "til"/"fra" in Swedish. Exact lowercase tokens only; every listed word is
  // impossible as a word of the target language (English "I" is always
  // capitalised; Swedish has "och/till/från/vid/inte/också"). Tokens that occur
  // verbatim in the entity name are proper-noun parts and are allowed.
  const stopwords = lang === "sv" ? NORWEGIAN_STOPWORDS_NOT_SWEDISH : NORWEGIAN_STOPWORDS_NOT_ENGLISH;
  const nameTokens = new Set(String(opts.entityName || "").split(splitRe).filter(Boolean));
  // "Sogn og Fjordane", "Smak av Nordhordland", "Smaker fra Stjørdalsføret": a
  // conjunction/preposition inside a capitalised phrase is part of a NAME when
  // the phrase (a) is a known county with "og", (b) occurs in the entity name,
  // or (c) is introduced in the source by a membership marker ("del av",
  // "medlem av", "nettverket", …). Plain coordination ("Bergen og Oslo",
  // "Kari og Ola") has no such marker and still fails. One phrase per text.
  // Locative "i" ("Nordlandsmuseet i Bodø") never qualifies.
  const NAME_PHRASE_WORDS = new Set(["og", "av", "fra"]);
  const stripEdges = (w: string): string => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const outTokens = out.split(/\s+/).map(stripEdges).filter(Boolean);
  const srcFlat = " " + srcWs.flatMap((w) => w.split("-")).map(stripEdges).filter(Boolean).join(" ") + " ";
  const entityNameFlat = " " + String(opts.entityName || "").split(/\s+/).map(stripEdges).filter(Boolean).join(" ") + " ";
  let namePhraseBudget = 2;
  const inNamePhrase = (i: number): boolean => {
    if (namePhraseBudget <= 0 || i < 1 || i >= outTokens.length - 1 || !NAME_PHRASE_WORDS.has(outTokens[i])) return false;
    const phrase = ` ${outTokens[i - 1]} ${outTokens[i]} ${outTokens[i + 1]} `;
    if (!/^[A-ZÆØÅ]/.test(outTokens[i - 1]) || !/^[A-ZÆØÅ]/.test(outTokens[i + 1]) || !srcFlat.includes(phrase)) return false;
    const known = KNOWN_NAME_PHRASES.has(phrase.trim().toLowerCase()) || entityNameFlat.toLowerCase().includes(phrase.toLowerCase());
    const before = srcFlat.slice(0, srcFlat.indexOf(phrase));
    const marked = NAME_MARKER_RE.test(before.slice(-45));
    if (!known && !marked) return false;
    namePhraseBudget--;
    return true;
  };
  // Stopword hits are counted on the punctuation-split tokens (so "og/eller"
  // and "coffee,og" are seen); a hit is excused only when every whitespace
  // occurrence of that word sits inside one licensed name phrase.
  const stopHits = Array.from(new Set(out.split(splitRe).filter((w) => stopwords.has(w) && !nameTokens.has(w) && !(allProperNounTitle && NAME_PHRASE_WORDS.has(w)))));
  const leakedStop = stopHits.filter((w) => {
    const occurrences = outTokens.map((t, i) => (t === w ? i : -1)).filter((i) => i >= 0);
    const splitCount = out.split(splitRe).filter((t) => t === w).length;
    if (occurrences.length !== splitCount) return true;
    return !occurrences.every((i) => inNamePhrase(i));
  });
  checks.push({ name: "no_norwegian_stopwords", ok: leakedStop.length === 0, detail: leakedStop.slice(0, 5).join(",") || undefined });

  if (kind === "title") {
    checks.push({ name: "title_single_line", ok: !/\n/.test(out) && out.length <= 300 });
  }

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  return { ok: failed.length === 0, checks, failed };
}

// ─── LLM calls (raw fetch, house pattern — see contact-candidate-judge.ts) ─

export interface LlmDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  translatorModel?: string;
  reviewerModel?: string;
}

export type LlmJsonResult =
  | { ok: true; json: any; raw: string; model: string; usage: { input_tokens: number; output_tokens: number } }
  | { ok: false; reason: string; model: string };

export async function callClaudeJson(
  deps: LlmDeps,
  params: { model: string; system: string; user: string; maxTokens?: number },
): Promise<LlmJsonResult> {
  const apiKey = deps.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = params.model;
  if (!apiKey) return { ok: false, reason: "ANTHROPIC_API_KEY mangler — avvist fail-closed", model };
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: params.maxTokens ?? 4096,
        system: params.system,
        messages: [{ role: "user", content: params.user }],
      }),
    });
  } catch {
    return { ok: false, reason: "nettverksfeil under LLM-kall — avvist fail-closed", model };
  }
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 200); } catch { /* ignore */ }
    return { ok: false, reason: `LLM-API svarte status ${response.status}${detail ? ": " + detail : ""}`, model };
  }
  let result: any;
  try {
    result = await response.json();
  } catch {
    return { ok: false, reason: "ikke-parsbar JSON fra LLM-API — avvist fail-closed", model };
  }
  if (result?.stop_reason === "refusal") return { ok: false, reason: "LLM avslo forespørselen (refusal) — avvist fail-closed", model };
  if (result?.stop_reason === "max_tokens") return { ok: false, reason: "LLM-svar avkuttet (max_tokens) — avvist fail-closed", model };
  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
  if (!text.trim()) return { ok: false, reason: "tomt tekstsvar fra LLM — avvist fail-closed", model };
  const json = extractJsonObject(text);
  if (!json) return { ok: false, reason: "LLM-svar inneholdt ikke et gyldig JSON-objekt — avvist fail-closed", model };
  const usage = {
    input_tokens: Number(result?.usage?.input_tokens || 0),
    output_tokens: Number(result?.usage?.output_tokens || 0),
  };
  return { ok: true, json, raw: text, model: String(result?.model || model), usage };
}

/** Pull the first {...} object out of a model reply (tolerates ``` fences and prose around it). */
export function extractJsonObject(text: string): any | null {
  const stripped = text.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const LANG_NAMES: Record<TranslationTargetLang, string> = { en: "English", sv: "Swedish" };

/** Fixed domain glossary so the same Norwegian term never gets three different
 *  renderings across profiles. Kept short on purpose; the prompt tells the
 *  model to keep proper nouns untouched. */
export const TRANSLATION_GLOSSARY: Record<TranslationTargetLang, Array<[string, string]>> = {
  en: [
    ["gårdsutsalg / gårdsbutikk", "farm shop"],
    ["gårdssalg", "farm sales (direct sales from the producer)"],
    ["REKO-ring", "REKO ring (keep the name; add \"(local food pick-up network)\" once if the text explains it)"],
    ["Bondens marked", "Bondens marked (farmers' market) — keep the Norwegian name"],
    ["smaking", "tasting"],
    ["omvisning", "guided tour"],
    ["sideri", "cidery"],
    ["mjøderi", "meadery"],
    ["bryggeri", "brewery"],
    ["villsau / gammelnorsk sau", "villsau (Old Norwegian heritage sheep) — a domestic breed, never \"wild sheep\""],
    ["fetevarer", "delicatessen (cheese, butter, cured meats and other deli goods) — not \"cured meats\" alone"],
    ["saft (solbærsaft, bringebærsaft)", "cordial (a concentrate to dilute) — \"juice\" only for juice/eplemost"],
    ["morr / fenalår / pinnekjøtt / spekemat", "keep the Norwegian name with a gloss on first use: morr (cured sausage), fenalår (cured leg of lamb), pinnekjøtt (salted lamb ribs); spekemat = cured meats"],
    ["destilleri", "distillery"],
    ["økologisk / Debio-godkjent", "organic / Debio-certified"],
    ["kortreist mat", "locally sourced food"],
    ["opplevelse", "experience"],
    ["tilbyder", "provider"],
    ["fylke / kommune", "county / municipality (keep the Norwegian place name itself)"],
    ["kr / NOK", "NOK (keep the amount exactly as in the source)"],
  ],
  sv: [
    ["gårdsutsalg / gårdsbutikk", "gårdsbutik"],
    ["gårdssalg", "gårdsförsäljning (direktförsäljning från producenten)"],
    ["REKO-ring", "REKO-ring (behåll namnet)"],
    ["Bondens marked", "Bondens marked (bondens marknad) — behåll det norska namnet"],
    ["smaking", "provsmakning"],
    ["omvisning", "visning / guidad tur"],
    ["sideri", "cideri"],
    ["mjøderi", "mjödbryggeri"],
    ["bryggeri", "bryggeri"],
    ["villsau / gammelnorsk sau", "villsau (gammalnorsk får, en tamfårsras) — aldrig \"vilda får\""],
    ["fetevarer", "delikatesser (ost, smör, charkuterier) — inte enbart \"charkuterier\""],
    ["saft", "saft (koncentrat) — \"juice\" endast för juice/eplemost"],
    ["destilleri", "destilleri"],
    ["økologisk / Debio-godkjent", "ekologisk / Debio-certifierad"],
    ["kortreist mat", "närproducerad mat"],
    ["opplevelse", "upplevelse"],
    ["tilbyder", "arrangör"],
    ["fylke / kommune", "fylke / kommun (behåll det norska ortnamnet)"],
    ["kr / NOK", "NOK (behåll beloppet exakt som i källan)"],
  ],
};

function glossaryText(lang: TranslationTargetLang): string {
  return TRANSLATION_GLOSSARY[lang].map(([no, target]) => `- ${no} → ${target}`).join("\n");
}

const PLATFORM_CONTEXT: Record<TranslationPlatform, string> = {
  rfb: "Rett fra Bonden (rettfrabonden.com), a Norwegian directory of local food producers — farms, farm shops, REKO rings, farmers' markets and cooperatives.",
  opplevagent: "Opplevagent (opplevagent.no), a curated Norwegian marketplace for experiences and activities, including farm-sales visits at breweries, cideries, meaderies and distilleries.",
};

const FIELD_CONTEXT: Record<string, string> = {
  description: "the producer's / experience's short description shown at the top of its public profile page",
  about: "the longer \"about the producer\" text on the public profile page",
  title: "the experience's display title (a short phrase, shown as the page heading)",
  meeting_point: "the meeting point / where to show up for the experience (a short practical line)",
  about_text: "the \"about the producer\" text on a farm-sales producer profile",
  visit_text: "the \"the visit\" text describing what a visit at this producer includes",
  opening_hours_text: "free-text opening hours (keep every day name, time and number exactly)",
};

export function buildTranslatorSystemPrompt(lang: TranslationTargetLang): string {
  return `You are a professional Norwegian-to-${LANG_NAMES[lang]} translator working for a Norwegian marketplace. You translate short public profile texts written by or about real, named businesses.

Rules — all of them are mandatory:
1. Translate the MEANING faithfully into natural, idiomatic ${LANG_NAMES[lang]} as a native copywriter would phrase it. Never translate word for word, never leave Norwegian sentence structure behind, but never add, remove, soften or embellish facts either.
2. Keep every proper noun unchanged: business/farm names, product brand names, place names (Ålesund stays Ålesund), people's names. Do not translate or "correct" them.
3. Keep every number, price, currency (NOK/kr → NOK), date, time, URL, e-mail address and phone number EXACTLY as written in the source. Do not convert currencies or units. Ordinals written with digits stay digits: "6. generasjon" → ${lang === "sv" ? "6:e generationen" : "6th generation"}, never spelled out.
4. Keep the paragraph structure. Plain text only: no markdown, no HTML, no bullet symbols the source does not have, no headings, no quotation marks around the whole text.
5. Use this glossary consistently:
${glossaryText(lang)}
6. If the source text is ALREADY written in ${LANG_NAMES[lang]}, return it with only obvious typos fixed and set "already_target_language" to true.
7. Never invent content to fill gaps. If the source is truncated or unclear, translate exactly what is there and mention it in "notes".
8. Some Norwegian words may be kept deliberately: names of dishes and products with no ${LANG_NAMES[lang]} equivalent (rømmegrøt, pinnekjøtt, lefse) and the land unit "mål". Keep such a word as written, add a short gloss in parentheses on first use (e.g. "rømmegrøt (sour cream porridge)", "90 mål (about 9 hectares)"), and list every kept word in "kept_terms". Ordinary Norwegian words are never kept.

Respond with ONE JSON object and nothing else:
{"translation": "<the ${LANG_NAMES[lang]} text>", "already_target_language": false, "kept_terms": ["<Norwegian words you deliberately kept, or empty>"], "notes": "<short translator notes, or empty string>"}`;
}

export function buildTranslatorUserPrompt(
  platform: TranslationPlatform,
  item: SourceItem,
  lang: TranslationTargetLang,
  feedback?: string | null,
): string {
  const lines = [
    `Platform: ${PLATFORM_CONTEXT[platform]}`,
    `Business / experience name (do not translate): ${item.entity_name || "(unknown)"}`,
    `Field: ${item.field} — ${FIELD_CONTEXT[item.field] || "profile text"}`,
    `Target language: ${LANG_NAMES[lang]}`,
  ];
  if (feedback) {
    lines.push("", "An independent reviewer rejected the previous attempt. Fix EVERY issue below without introducing new ones:", feedback);
  }
  lines.push("", "Source text (Norwegian):", "<<<", item.text, ">>>");
  return lines.join("\n");
}

export function buildReviewerSystemPrompt(lang: TranslationTargetLang): string {
  return `You are a senior ${LANG_NAMES[lang]} linguist doing independent quality assurance on a Norwegian→${LANG_NAMES[lang]} translation of a public business profile text. You did NOT produce the translation. Judge it strictly; a wrong translation will be published under a real business's name.

Assess:
- fidelity (1-5): does the translation say exactly what the source says — no omissions, additions, changed facts, wrong numbers/prices/times, mistranslated terms?
- fluency (1-5): does it read as natural, idiomatic ${LANG_NAMES[lang]} written by a native copywriter — not word-for-word, no Norwegian sentence structure, correct grammar and register?
- preserved items: proper nouns, numbers, prices, URLs, e-mails and phone numbers must be unchanged.
- leftovers: any Norwegian words that should have been translated (proper nouns are fine).

Verdict rules:
- APPROVE only if fidelity ≥ 4 AND fluency ≥ 4 AND there is no "major" issue.
- REVISE if the problems are fixable by a re-translation (list them precisely).
- REJECT if the translation is fundamentally wrong, invents content, or the source is not translatable as-is.

Respond with ONE JSON object and nothing else:
{"verdict": "APPROVE" | "REVISE" | "REJECT", "fidelity": 1-5, "fluency": 1-5, "issues": [{"type": "meaning|omission|addition|number|terminology|grammar|style|untranslated|format", "severity": "minor|major", "detail": "<what and where>"}], "summary": "<one sentence>"}`;
}

export function buildReviewerUserPrompt(platform: TranslationPlatform, item: SourceItem, lang: TranslationTargetLang, translation: string, keptTerms?: string[] | null): string {
  const kept = Array.isArray(keptTerms) ? keptTerms.filter(Boolean) : [];
  return [
    `Platform: ${PLATFORM_CONTEXT[platform]}`,
    `Business / experience name: ${item.entity_name || "(unknown)"}`,
    `Field: ${item.field} — ${FIELD_CONTEXT[item.field] || "profile text"}`,
    `Glossary the translator was told to use:`,
    glossaryText(lang),
    kept.length ? `Norwegian words the translator says it kept on purpose (judge whether that is right — only dish/product names and the unit "mål" qualify, and each needs a gloss): ${kept.join(", ")}` : "",
    "",
    "Source (Norwegian):",
    "<<<",
    item.text,
    ">>>",
    "",
    `Translation (${LANG_NAMES[lang]}) to review:`,
    "<<<",
    translation,
    ">>>",
  ].join("\n");
}

export interface ReviewVerdict {
  verdict: "APPROVE" | "REVISE" | "REJECT";
  fidelity: number;
  fluency: number;
  issues: Array<{ type: string; severity: string; detail: string }>;
  summary: string;
}

export function parseReviewVerdict(json: any): ReviewVerdict | null {
  const v = String(json?.verdict || "").toUpperCase();
  if (v !== "APPROVE" && v !== "REVISE" && v !== "REJECT") return null;
  const fidelity = Number(json?.fidelity);
  const fluency = Number(json?.fluency);
  if (!Number.isFinite(fidelity) || !Number.isFinite(fluency)) return null;
  const issues = Array.isArray(json?.issues)
    ? json.issues
        .filter((i: any) => i && typeof i === "object")
        .map((i: any) => ({ type: String(i.type || "other"), severity: String(i.severity || "minor"), detail: String(i.detail || "") }))
    : [];
  return { verdict: v as ReviewVerdict["verdict"], fidelity, fluency, issues, summary: String(json?.summary || "") };
}

/** The policy in one place: what the reviewer must return for the pipeline
 *  to accept the translation (independent of the verdict word alone). */
export function reviewAccepts(r: ReviewVerdict): boolean {
  if (r.verdict !== "APPROVE") return false;
  if (r.fidelity < 4 || r.fluency < 4) return false;
  if (r.issues.some((i) => i.severity === "major")) return false;
  return true;
}

// ─── Processing one item ─────────────────────────────────────────────────

export type ItemOutcome =
  | "verified"
  | "rejected_review"
  | "rejected_verify"
  | "translate_failed"
  | "review_failed"
  | "skipped";

export interface ItemResult {
  id: number;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  field: string;
  lang: TranslationTargetLang;
  outcome: ItemOutcome;
  status: TranslationStatus;
  attempts: number;
  reason?: string;
  review?: ReviewVerdict | null;
  verify?: VerifyResult | null;
  usage: { input_tokens: number; output_tokens: number; calls: number };
}

function addUsage(acc: { input_tokens: number; output_tokens: number; calls: number }, r: LlmJsonResult): void {
  acc.calls++;
  if (r.ok) {
    acc.input_tokens += r.usage.input_tokens;
    acc.output_tokens += r.usage.output_tokens;
  }
}

function feedbackFromReview(r: ReviewVerdict): string {
  const lines = r.issues.map((i) => `- [${i.severity}] ${i.type}: ${i.detail}`);
  if (r.summary) lines.push(`- summary: ${r.summary}`);
  return lines.join("\n") || "- reviewer did not approve (no detail given)";
}

/**
 * Run translate → review → (one revision round) → deterministic verify for a
 * single planned item, persisting every step. Never throws; every failure
 * path leaves the row in a state the next run (or a human) can pick up.
 */
export async function processTranslationItem(
  db: Database.Database,
  platform: TranslationPlatform,
  planned: PlannedItem,
  batchId: string,
  deps: LlmDeps = {},
): Promise<ItemResult> {
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let row = upsertDraft(db, platform, planned, batchId);
  const item = planned.item;
  const lang = planned.lang;
  const tModel = deps.translatorModel || translatorModel();
  const rModel = deps.reviewerModel || reviewerModel();
  const base = { id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, entity_name: row.entity_name, field: row.field, lang };

  let feedback: string | null = null;
  let lastReview: ReviewVerdict | null = null;

  while (row.attempts < MAX_TRANSLATION_ATTEMPTS) {
    // ── translate ──
    const tr = await callClaudeJson(deps, {
      model: tModel,
      system: buildTranslatorSystemPrompt(lang),
      user: buildTranslatorUserPrompt(platform, item, lang, feedback),
    });
    addUsage(usage, tr);
    const attemptsNow = row.attempts + 1;
    if (!tr.ok) {
      const infra = LLM_INFRA_REASON_RE.test(tr.reason);
      row = setStatus(db, row, "draft", { attempts: infra ? row.attempts : attemptsNow, translator_model: tModel, translator_notes: `translate failed: ${tr.reason}`, batch_id: batchId }, "pipeline", `translate failed${infra ? " (infra, attempt not counted)" : ""}: ${tr.reason}`, batchId);
      return { ...base, outcome: "translate_failed", status: row.status, attempts: row.attempts, reason: tr.reason, review: lastReview, verify: null, usage };
    }
    const translation = cleanSource(tr.json?.translation);
    const alreadyTarget = tr.json?.already_target_language === true;
    const notes = String(tr.json?.notes ?? "").slice(0, 1000);
    const keptTerms: string[] = Array.isArray(tr.json?.kept_terms) ? tr.json.kept_terms.map((t: unknown) => String(t).trim()).filter((t: string) => t && t.length <= 40).slice(0, 8) : [];
    // The verifier honours at most 4 declared terms and only with a gloss (see verifyTranslationDeterministic).
    if (!translation) {
      row = setStatus(db, row, "draft", { attempts: attemptsNow, translator_model: tr.model, translator_notes: "translate failed: empty translation", batch_id: batchId }, "pipeline", "translate failed: empty translation", batchId);
      return { ...base, outcome: "translate_failed", status: row.status, attempts: row.attempts, reason: "empty translation", review: lastReview, verify: null, usage };
    }
    row = setStatus(db, row, "draft", { attempts: attemptsNow, translated_text: translation, translator_model: tr.model, translator_notes: (alreadyTarget ? "[already_target_language] " : "") + (keptTerms.length ? `[kept: ${keptTerms.join(", ")}] ` : "") + notes, batch_id: batchId }, "pipeline", `translated (attempt ${attemptsNow})`, batchId);

    // ── independent review ──
    const rv = await callClaudeJson(deps, {
      model: rModel,
      system: buildReviewerSystemPrompt(lang),
      user: buildReviewerUserPrompt(platform, item, lang, translation, keptTerms),
      maxTokens: 2048,
    });
    addUsage(usage, rv);
    if (!rv.ok) {
      row = setStatus(db, row, "draft", { reviewer_model: rModel, review_json: JSON.stringify({ error: rv.reason }) }, "pipeline", `review failed: ${rv.reason}`, batchId);
      return { ...base, outcome: "review_failed", status: row.status, attempts: row.attempts, reason: rv.reason, review: null, verify: null, usage };
    }
    const verdict = parseReviewVerdict(rv.json);
    if (!verdict) {
      row = setStatus(db, row, "draft", { reviewer_model: rv.model, review_json: JSON.stringify({ error: "unparseable verdict", raw: rv.raw.slice(0, 500) }) }, "pipeline", "review failed: unparseable verdict", batchId);
      return { ...base, outcome: "review_failed", status: row.status, attempts: row.attempts, reason: "unparseable review verdict", review: null, verify: null, usage };
    }
    lastReview = verdict;
    row = setStatus(db, row, "reviewed", { reviewer_model: rv.model, review_json: JSON.stringify(verdict), reviewed_at: nowIso() }, "pipeline", `reviewed: ${verdict.verdict} f${verdict.fidelity}/fl${verdict.fluency}`, batchId);

    if (reviewAccepts(verdict)) {
      // ── deterministic verify ──
      const vr = verifyTranslationDeterministic(item.text, translation, lang, { kind: item.kind, alreadyTargetLanguage: alreadyTarget, entityName: item.entity_name, keptTerms });
      if (vr.ok) {
        row = setStatus(db, row, "verified", { verify_json: JSON.stringify(vr), verified_at: nowIso(), reject_reason: null }, "pipeline", "verified", batchId);
        return { ...base, outcome: "verified", status: row.status, attempts: row.attempts, review: verdict, verify: vr, usage };
      }
      const reason = `deterministic verify failed: ${vr.failed.join(", ")}`;
      row = setStatus(db, row, "rejected", { verify_json: JSON.stringify(vr), reject_reason: reason }, "pipeline", reason, batchId);
      return { ...base, outcome: "rejected_verify", status: row.status, attempts: row.attempts, reason, review: verdict, verify: vr, usage };
    }

    if (verdict.verdict === "REVISE" && row.attempts < MAX_TRANSLATION_ATTEMPTS) {
      feedback = feedbackFromReview(verdict);
      continue;
    }
    const reason = `reviewer ${verdict.verdict} (fidelity ${verdict.fidelity}, fluency ${verdict.fluency}): ${verdict.summary || feedbackFromReview(verdict)}`.slice(0, 1000);
    row = setStatus(db, row, "rejected", { reject_reason: reason }, "pipeline", reason, batchId);
    return { ...base, outcome: "rejected_review", status: row.status, attempts: row.attempts, reason, review: verdict, verify: null, usage };
  }

  // Loop exhausted without a terminal decision (only reachable when attempts
  // were already at the cap when we started — planItem() normally prevents it).
  const reason = lastReview
    ? `reviewer ${lastReview.verdict} after ${row.attempts} attempts: ${lastReview.summary}`
    : `max attempts (${MAX_TRANSLATION_ATTEMPTS}) reached`;
  row = setStatus(db, row, "rejected", { reject_reason: reason }, "pipeline", reason, batchId);
  return { ...base, outcome: "rejected_review", status: row.status, attempts: row.attempts, reason, review: lastReview, verify: null, usage };
}

// ─── Publish / unpublish / manual QA ─────────────────────────────────────

export function publishVerified(
  db: Database.Database,
  platform: TranslationPlatform,
  lang: TranslationTargetLang,
  opts: { ids?: number[]; dryRun: boolean; batchId: string; actor: string },
): { would_publish: number; published: number; ids: number[] } {
  let rows: TranslationRow[];
  if (opts.ids && opts.ids.length) {
    const placeholders = opts.ids.map(() => "?").join(",");
    rows = db
      .prepare(`SELECT * FROM profile_translations WHERE platform = ? AND lang = ? AND status = 'verified' AND id IN (${placeholders})`)
      .all(platform, lang, ...opts.ids) as TranslationRow[];
  } else {
    rows = db.prepare(`SELECT * FROM profile_translations WHERE platform = ? AND lang = ? AND status = 'verified'`).all(platform, lang) as TranslationRow[];
  }
  if (opts.dryRun) return { would_publish: rows.length, published: 0, ids: rows.map((r) => r.id) };
  const tx = db.transaction(() => {
    for (const r of rows) setStatus(db, r, "published", { published_at: nowIso(), batch_id: opts.batchId }, opts.actor, "published", opts.batchId);
  });
  tx();
  return { would_publish: rows.length, published: rows.length, ids: rows.map((r) => r.id) };
}

export function unpublish(
  db: Database.Database,
  platform: TranslationPlatform,
  lang: TranslationTargetLang,
  opts: { ids?: number[]; batchId: string; actor: string; reason?: string },
): { unpublished: number; ids: number[] } {
  let rows: TranslationRow[];
  if (opts.ids && opts.ids.length) {
    const placeholders = opts.ids.map(() => "?").join(",");
    rows = db
      .prepare(`SELECT * FROM profile_translations WHERE platform = ? AND lang = ? AND status = 'published' AND id IN (${placeholders})`)
      .all(platform, lang, ...opts.ids) as TranslationRow[];
  } else {
    rows = db.prepare(`SELECT * FROM profile_translations WHERE platform = ? AND lang = ? AND status = 'published'`).all(platform, lang) as TranslationRow[];
  }
  const tx = db.transaction(() => {
    for (const r of rows) setStatus(db, r, "verified", { published_at: null }, opts.actor, opts.reason || "unpublished", opts.batchId);
  });
  tx();
  return { unpublished: rows.length, ids: rows.map((r) => r.id) };
}

/** Manual QA: a human (or the routine's spot-check) rejects a row in any state. */
export function rejectTranslation(db: Database.Database, id: number, reason: string, actor: string): TranslationRow | null {
  const row = getTranslationById(db, id);
  if (!row) return null;
  return setStatus(db, row, "rejected", { reject_reason: reason.slice(0, 1000), published_at: null }, actor, `manual reject: ${reason}`.slice(0, 1000), null);
}

/** Put a rejected/draft row back on the belt with a fresh attempt budget. */
export function requeueTranslation(db: Database.Database, id: number, actor: string): TranslationRow | null {
  const row = getTranslationById(db, id);
  if (!row) return null;
  return setStatus(db, row, "draft", { attempts: 0, reject_reason: null, review_json: null, verify_json: null, published_at: null, verified_at: null, reviewed_at: null }, actor, "requeued", null);
}

export function translationStatusCounts(db: Database.Database, platform: TranslationPlatform): Record<string, Record<string, number>> {
  const rows = db
    .prepare(`SELECT lang, status, COUNT(*) AS n FROM profile_translations WHERE platform = ? GROUP BY lang, status`)
    .all(platform) as Array<{ lang: string; status: string; n: number }>;
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    out[r.lang] = out[r.lang] || {};
    out[r.lang][r.status] = r.n;
  }
  return out;
}

export function listTranslationQueue(
  db: Database.Database,
  platform: TranslationPlatform,
  opts: { lang?: TranslationTargetLang; status?: TranslationStatus; limit?: number; entityId?: string } = {},
): TranslationRow[] {
  const where: string[] = ["platform = ?"];
  const vals: unknown[] = [platform];
  if (opts.lang) { where.push("lang = ?"); vals.push(opts.lang); }
  if (opts.status) { where.push("status = ?"); vals.push(opts.status); }
  if (opts.entityId) { where.push("entity_id = ?"); vals.push(opts.entityId); }
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  return db
    .prepare(`SELECT * FROM profile_translations WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`)
    .all(...(vals as any[])) as TranslationRow[];
}

export function listTranslationAudit(db: Database.Database, translationId: number, limit = 50): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT * FROM profile_translation_audit WHERE translation_id = ? ORDER BY id DESC LIMIT ?`)
    .all(translationId, limit) as Array<Record<string, unknown>>;
}

// ─── Serving (what the SSR routes call) ──────────────────────────────────

/**
 * Published translations for one entity, keyed by field. Returns {} unless
 * lang is a target language AND PROFILE_TRANSLATIONS_SERVE_ENABLED === "true"
 * (or opts.ignoreServeFlag for the admin preview). Never throws — a missing
 * table (older test DB) just means "no translations".
 */
export function getPublishedProfileTranslations(
  db: Database.Database,
  platform: TranslationPlatform,
  entityType: string,
  entityId: string,
  lang: string,
  opts: { ignoreServeFlag?: boolean; includeVerified?: boolean } = {},
): Record<string, string> {
  if (lang !== "en" && lang !== "sv") return {};
  if (!opts.ignoreServeFlag && !isProfileTranslationServingEnabled()) return {};
  try {
    const statuses = opts.includeVerified ? "('published','verified')" : "('published')";
    const rows = db
      .prepare(
        `SELECT field, translated_text FROM profile_translations
          WHERE platform = ? AND entity_type = ? AND entity_id = ? AND lang = ? AND status IN ${statuses}
            AND translated_text IS NOT NULL AND translated_text != ''`,
      )
      .all(platform, entityType, String(entityId), lang) as Array<{ field: string; translated_text: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.field] = r.translated_text;
    return out;
  } catch {
    return {};
  }
}

/** Bulk variant for list/card renderers: Map<entity_id, {field: text}>. */
export function getPublishedProfileTranslationsBulk(
  db: Database.Database,
  platform: TranslationPlatform,
  entityType: string,
  entityIds: string[],
  lang: string,
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (lang !== "en" && lang !== "sv") return out;
  if (!isProfileTranslationServingEnabled()) return out;
  const ids = Array.from(new Set(entityIds.map((s) => String(s)).filter(Boolean)));
  if (!ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT entity_id, field, translated_text FROM profile_translations
            WHERE platform = ? AND entity_type = ? AND lang = ? AND status = 'published'
              AND translated_text IS NOT NULL AND translated_text != '' AND entity_id IN (${placeholders})`,
        )
        .all(platform, entityType, lang, ...chunk) as Array<{ entity_id: string; field: string; translated_text: string }>;
      for (const r of rows) {
        const m = out.get(r.entity_id) || {};
        m[r.field] = r.translated_text;
        out.set(r.entity_id, m);
      }
    }
  } catch {
    /* table missing → no translations */
  }
  return out;
}
