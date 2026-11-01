// ─── «Hold profilen oppdatert» — the owner refresh (H1) ─────────────────────
//
// dev-request 2026-11-01-rfb-hold-profilen-oppdatert (Daniel live 2026-11-01,
// record daniel-responses/2026-11-01-live-hold-profilen-oppdatert.md). Until
// now an owned profile was never refreshed: the nightly enrichment's cohort
// (rfb-enrichment-nightly.ts) leaves out every `customer` and `curated` row.
// An owner now chooses with auto.updates what happens when we find new
// information on their own website: «Fyll tomme felt selv» (fill_empty,
// the default for every owner), «Oppdateres automatisk hver natt»
// (automatic) or «Aldri» (never = skipped, as before).
//
// Where it runs: the LAST step of the nightly run (runSteps, after step 5),
// behind OWNER_AUTO_UPDATES_ENABLED (default off: no step, no report key, no
// envelope claim). Inside the run it shares the verifier tick lock, the 08Z
// ban, the run deadline, the enrichment write-pause, the per-night LLM cap
// with its durable reservation, the rotation memory (rfb_enrichment_nightly_
// attempts, step `owner_refresh`) and the run-ledger envelope. Because it
// starts only after every unowned step has finished, the unowned cohort's
// selection, writes, time and LLM budget are exactly what they were; it only
// uses what is left.
//
// Extractor: the nightly's content_refresh extractor, refreshHomepageContent
// (routes/admin-knowledge.ts) — the same SSRF-guarded fetch of the owner's
// own homepage, the same about/description guards (quality bar,
// substantiation, code artifact, theme spam, Økologi S3b), the same three
// about judges and the same write gate (canCorrectFactualField, curated
// lock) — run as a dry run with `planOnlyFields`: it is limited to the fields
// this owner's choice wants, never touches a column, and hands back the
// writes its gate approved. This module then writes them itself, one
// transaction per profile, after re-reading the row:
//   • only fields in OWNER_REFRESH_FIELDS and never one in
//     OWNER_REFRESH_NEVER_FIELDS (products and prices, stock, organic /
//     certification claims, e-mail, order settings);
//   • fill_empty: only a field that is empty now; automatic: also a non-empty
//     one — never one the owner saved (curated_fields by owner, an `owner`
//     provenance record, or any field of a profile the owner wrote through the
//     /selger editor: data_source owner/hybrid) and never one customer service
//     locked (any curated_fields entry); about and description go together
//     and are left alone when either is locked;
//   • no prose with an organic claim word, no organic category (whatever the
//     Debio status — the owner states those, we do not);
//   • `about` through knowledgeService.upsertKnowledge with the owner lock
//     forced on (enforceOwnerLock, also with OWNER_LOCK_ENFORCE_WRITES off);
//     agents.description / agents.categories behind the same owner-lock rule
//     (ownerLockedFieldKeys);
//   • one agent_knowledge_audit row per written field (changed_by 'system',
//     notes with the choice, the source and its URL, the run id): the owner
//     sees it in the portal's «Endringslogg» (GET /api/agents/:id/my-audit);
//   • the website_homepage provenance record merged as the extractor would.
// Nothing else is written for an owned profile: no fetch bookkeeping, no
// parking, no rotation stamp on agent_knowledge, no review-queue proposal.
//
// Not reused for owned profiles (they cannot be limited to the allowed
// fields): the Brreg / Bondens Marked / contact-extraction steps write e-mail
// (and phone) directly inside their admin routes, and the website steps feed
// the website review queue, whose approval writes without the owner lock.
// So today the owner refresh fills about/description and categories only.

import { randomBytes } from "crypto";
import { isOwnPlatformHomepage } from "../database/init";
import { customerRuleSql } from "./customer-rule";
import { yieldToEventLoop } from "./boot-job-gate";
import { hostFromUrlLike, isDirectoryOrAggregatorHost } from "./cross-source-validator";
import { rfbWebsiteHostExclusionReason } from "../routes/admin-rfb-website-discovery";
import {
  currentHcrAboutJudges,
  mergeFieldProvenance,
  refreshHomepageContent,
  selectHomepageContentRefreshTargetsByIds,
  HCR_DEADLINE_EXCEEDED,
  HCR_THEME_SPAM_CANDIDATE_REASON,
  HCR_THEME_SPAM_PAGE_ERROR,
  type HcrAboutJudges,
  type HcrPlannedWrite,
} from "../routes/admin-knowledge";
import { knowledgeService, ownerLockedFieldKeys } from "./knowledge-service";
import { containsOrganicClaim, stripOrganicCategories } from "./organic-claims";
import { noteLlmCall } from "./llm-call-meter";
import { isEnrichmentAboutPageEnabled } from "./about-page-candidate";
import { resolveOwnerFeatureKeysForSubjects } from "../owner-features/resolve";
import { ownerAutoUpdatesEnabled } from "../owner-features/registry";

type Db = any;

// ─── Knobs ─────────────────────────────────────────────────────────────────

/** Step key in rfb_enrichment_nightly_attempts (the rotation memory). */
export const OWNER_REFRESH_STEP = "owner_refresh";
export const OWNER_REFRESH_CAP_ENV = "RFB_ENRICHMENT_CAP_OWNER_REFRESH";
export const OWNER_REFRESH_CAP_DEFAULT = 15;
export const OWNER_REFRESH_CAP_MAX = 100;
/** Per-profile budget: one homepage fetch plus up to three about judges (8 s each). */
export const OWNER_REFRESH_PER_ROW_MS = 40_000;
/** automatic = «hver natt»: a profile is due again the next night. */
export const OWNER_REFRESH_AUTOMATIC_RETRY_MS = 20 * 3600_000;
/** fill_empty: after a real outcome, the nightly's own retry window (RFB_ENRICHMENT_RETRY_DAYS). */
export const OWNER_REFRESH_FILL_EMPTY_RETRY_MS_DEFAULT = 14 * 86_400_000;
/** The about judges' calls for one judged candidate: quality, facts, comparison. */
export const OWNER_REFRESH_JUDGE_CALLS_PER_PASS = 3;
/** llm-call-meter source of the about judges this refresh calls. */
export const OWNER_REFRESH_JUDGE_SOURCE = "owner-refresh-about-judge";

export type OwnerAutoUpdatesMode = "fill_empty" | "automatic";
export type OwnerRefreshField = "about" | "description" | "categories";

/**
 * The ONLY fields the owner refresh writes (allow list), in write order:
 * agent_knowledge.about, agents.description (same judged value, only with
 * about), agents.categories. Descriptive fields the spec also names —
 * opening hours, address/place, phone, website — have no extractor that can
 * be limited to them (see the header), so they are not written.
 */
export const OWNER_REFRESH_FIELDS: readonly OwnerRefreshField[] = ["about", "description", "categories"];

/**
 * Never written by the owner refresh, whatever an extractor proposes (spec
 * «Skriver aldri»), checked before every write on top of the allow list:
 * products and prices, stock, organic / certification claims, e-mail
 * addresses and order settings.
 */
export const OWNER_REFRESH_NEVER_FIELDS: readonly string[] = [
  "products", "price", "price_nok", "availability", "stock_expires_at",
  "certifications", "specialties", "debio_verified",
  "email", "contact_email", "order_notification_email", "order_notifications_opt_in",
];

const TABLE_OF: Record<OwnerRefreshField, HcrPlannedWrite["table"]> = {
  about: "agent_knowledge",
  description: "agents",
  categories: "agents",
};

export function resolveOwnerRefreshCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[OWNER_REFRESH_CAP_ENV] ?? "").trim();
  if (!/^\d+$/.test(raw)) return OWNER_REFRESH_CAP_DEFAULT;
  return Math.min(Math.max(parseInt(raw, 10), 0), OWNER_REFRESH_CAP_MAX);
}

// ─── Who, and with which choice ────────────────────────────────────────────

/** An owned profile's columns the refresh reads (and re-reads before writing). */
export interface OwnerRefreshSnapshot {
  id: string;
  name: string | null;
  a_url: string | null;
  description: string | null;
  categories: string | null;
  has_knowledge: boolean;
  k_website: string | null;
  about: string | null;
  curated_fields: string | null;
  field_provenance: string | null;
  data_source: string | null;
  homepage_unreachable_since: string | null;
}

/**
 * Verified-owner RFB producers (customerRuleSql — the same rule as the
 * nightly's `customer` exclusion and isVerifiedOwner), active, not an
 * umbrella. catalog_hidden rows are NOT left out: this job writes no e-mail
 * (the reason the e-mail lanes skip hidden rows), and the claim-test and
 * switch-probe fixtures are hidden owned profiles that must be observable.
 */
function snapshotSql(extraWhere = ""): string {
  return `
    SELECT a.id AS id, a.name AS name, a.url AS a_url, a.description AS description, a.categories AS categories,
           k.agent_id AS k_agent_id, k.website AS k_website, k.about AS about, k.curated_fields AS curated_fields,
           k.field_provenance AS field_provenance, k.data_source AS data_source,
           k.homepage_unreachable_since AS homepage_unreachable_since
      FROM agents a
      LEFT JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.role = 'producer'
       AND COALESCE(a.vertical_id, 'rfb') = 'rfb'
       AND a.is_active = 1
       AND a.umbrella_type IS NULL
       AND ${customerRuleSql("a")}
       ${extraWhere}
     ORDER BY a.created_at ASC, a.id ASC
  `;
}

function toSnapshot(r: any): OwnerRefreshSnapshot {
  return {
    id: r.id,
    name: r.name ?? null,
    a_url: r.a_url ?? null,
    description: r.description ?? null,
    categories: r.categories ?? null,
    has_knowledge: r.k_agent_id !== null && r.k_agent_id !== undefined,
    k_website: r.k_website ?? null,
    about: r.about ?? null,
    curated_fields: r.curated_fields ?? null,
    field_provenance: r.field_provenance ?? null,
    data_source: r.data_source ?? null,
    homepage_unreachable_since: r.homepage_unreachable_since ?? null,
  };
}

function loadSnapshot(db: Db, agentId: string): OwnerRefreshSnapshot | null {
  const row = db.prepare(snapshotSql("AND a.id = ?")).get(agentId);
  return row ? toSnapshot(row) : null;
}

/** auto.updates → the job's mode; «Aldri», a hidden or unknown value → null (skipped). */
function modeOf(value: unknown): OwnerAutoUpdatesMode | null {
  return value === "fill_empty" || value === "automatic" ? value : null;
}

function resolveModes(db: Db, ids: readonly string[], env: NodeJS.ProcessEnv): Map<string, OwnerAutoUpdatesMode | null> {
  const out = new Map<string, OwnerAutoUpdatesMode | null>();
  if (ids.length === 0) return out;
  const resolved = resolveOwnerFeatureKeysForSubjects("rfb", ids, ["auto.updates"], { db, env });
  for (const id of ids) out.set(id, modeOf(resolved.get(id)?.["auto.updates"]?.value));
  return out;
}

/**
 * The job's own decision per profile: "fill_empty" / "automatic" = taken by
 * the owner refresh with that choice; null = skipped (flag off, no verified
 * owner, inactive, umbrella, another vertical, or the owner chose «Aldri»).
 * Read by the cohort below, the write path and the switch probe.
 */
export function ownerRefreshModes(
  db: Db,
  ids: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Map<string, OwnerAutoUpdatesMode | null> {
  const out = new Map<string, OwnerAutoUpdatesMode | null>();
  for (const id of ids) out.set(id, null);
  if (!ownerAutoUpdatesEnabled(env) || ids.length === 0) return out;
  const owned = (db.prepare(snapshotSql(`AND a.id IN (${ids.map(() => "?").join(",")})`)).all(...ids) as any[]).map((r) => String(r.id));
  for (const [id, mode] of resolveModes(db, owned, env)) out.set(id, mode);
  return out;
}

// ─── Which fields ──────────────────────────────────────────────────────────

function blankText(v: string | null | undefined): boolean {
  return (v ?? "").trim() === "";
}

/** A stored category list with no entry (null, "", "[]", or a list of blanks). Unreadable text is NOT empty. */
function blankList(v: string | null | undefined): boolean {
  const t = (v ?? "").trim();
  if (t === "") return true;
  try {
    const p = JSON.parse(t);
    return Array.isArray(p) && p.every((x) => String(x ?? "").trim() === "");
  } catch {
    return false;
  }
}

/** A JSON object column; null = unreadable (callers fail closed). */
function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {};
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** field_provenance[field] carries an owner-attested record (source_type «owner», the gate's Tier S). */
function ownerAttested(prov: Record<string, unknown>, field: string): boolean {
  const v = prov[field];
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { sources?: unknown }).sources) ? (v as { sources: unknown[] }).sources : v ? [v] : [];
  return list.some((r) => {
    const st = r && typeof r === "object" ? (r as { source_type?: unknown }).source_type : null;
    return typeof st === "string" && st.trim().toLowerCase().split(":")[0] === "owner";
  });
}

/**
 * The fields this owner's choice lets the refresh write for this profile
 * now (the extractor is limited to them). Empty = nothing to do.
 *   locked   any curated_fields entry (an owner save stamps by:"owner",
 *            customer service its own name) or an owner provenance record;
 *            unreadable curated_fields / field_provenance → nothing (fail closed)
 *   empty    fill_empty writes only an empty field; automatic also a filled
 *            one, except on a profile the owner wrote through /selger
 *            (data_source owner/hybrid, no per-field trace) — there too only
 *            an empty field
 *   pair     about and description share one judged value: neither when
 *            either is locked, description only together with about
 *   categories  only an empty list, in both modes: the extractor never
 *            replaces a stored list (it only corroborates one, a
 *            provenance-only write this refresh does not take)
 */
export function plannedOwnerRefreshFields(s: OwnerRefreshSnapshot, mode: OwnerAutoUpdatesMode): OwnerRefreshField[] {
  const locks = parseObject(s.curated_fields);
  const prov = parseObject(s.field_provenance);
  if (locks === null || prov === null) return [];
  const locked = (f: string) => Object.prototype.hasOwnProperty.call(locks, f) || ownerAttested(prov, f);
  const ownerWroteProfile = s.data_source === "owner" || s.data_source === "hybrid";
  const may = (f: OwnerRefreshField, empty: boolean) => !locked(f) && (empty || (mode === "automatic" && !ownerWroteProfile));
  const out: OwnerRefreshField[] = [];
  if (!locked("about") && !locked("description") && may("about", blankText(s.about))) {
    out.push("about");
    if (may("description", blankText(s.description))) out.push("description");
  }
  if (!locked("categories") && blankList(s.categories)) out.push("categories");
  return out;
}

/** Worst-case model calls for one profile (its LLM reservation): the about judges, two passes in about-page mode. */
export function ownerRefreshRowLlmCallsMax(row: { fields: readonly OwnerRefreshField[] }): number {
  if (!row.fields.includes("about")) return 0;
  return OWNER_REFRESH_JUDGE_CALLS_PER_PASS * (isEnrichmentAboutPageEnabled() ? 2 : 1);
}

// ─── Cohort ────────────────────────────────────────────────────────────────

export interface OwnerRefreshRow {
  id: string;
  name: string;
  homepage: string;
  mode: OwnerAutoUpdatesMode;
  fields: OwnerRefreshField[];
}

export interface OwnerRefreshCohort {
  /** Verified-owner RFB producers looked at. */
  considered: number;
  /** Due tonight, least recently attempted first (then creation order). */
  eligible: OwnerRefreshRow[];
  /** Why the others are not taken. */
  skipped: Record<string, number>;
}

export interface OwnerRefreshCohortOptions {
  nowMs: number;
  /** step → agent_id → last attempt (readRfbEnrichmentAttempts). */
  attempts?: Map<string, Map<string, number>>;
  /** fill_empty retry window after a real outcome (the nightly passes RFB_ENRICHMENT_RETRY_DAYS). */
  fillEmptyRetryMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Same two host lists as the nightly's rfbEnrichmentHomepageHostExcluded: never someone else's page. */
function homepageHostExcluded(url: string): boolean {
  const host = hostFromUrlLike(url);
  if (!host) return false;
  return !!rfbWebsiteHostExclusionReason(host) || isDirectoryOrAggregatorHost(host);
}

/** Owned profiles the refresh would take now. Read-only; yields every 200 rows. */
export async function loadOwnerRefreshCohort(db: Db, opts: OwnerRefreshCohortOptions): Promise<OwnerRefreshCohort> {
  const env = opts.env ?? process.env;
  const snaps = (db.prepare(snapshotSql()).all() as any[]).map(toSnapshot);
  await yieldToEventLoop();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const modes = ownerAutoUpdatesEnabled(env) ? resolveModes(db, snaps.map((s) => s.id), env) : new Map<string, OwnerAutoUpdatesMode | null>();
  const last = opts.attempts?.get(OWNER_REFRESH_STEP) ?? new Map<string, number>();
  const retry: Record<OwnerAutoUpdatesMode, number> = {
    automatic: OWNER_REFRESH_AUTOMATIC_RETRY_MS,
    fill_empty: opts.fillEmptyRetryMs ?? OWNER_REFRESH_FILL_EMPTY_RETRY_MS_DEFAULT,
  };
  const picked: Array<{ row: OwnerRefreshRow; attemptMs: number }> = [];
  for (let i = 0; i < snaps.length; i++) {
    if (i > 0 && i % 200 === 0) await yieldToEventLoop();
    const s = snaps[i];
    const mode = modes.get(s.id) ?? null;
    if (!mode) { skip("never"); continue; }
    const homepage = (s.k_website ?? "").trim() || (s.a_url ?? "").trim();
    if (!homepage) { skip("no_homepage"); continue; }
    if (isOwnPlatformHomepage({ website: s.k_website, url: s.a_url })) { skip("own_platform_homepage"); continue; }
    if (homepageHostExcluded(homepage)) { skip("directory_or_social_host"); continue; }
    if (s.homepage_unreachable_since) { skip("homepage_unreachable"); continue; }
    const fields = plannedOwnerRefreshFields(s, mode);
    if (fields.length === 0) { skip("nothing_to_fill"); continue; }
    const attemptMs = last.get(s.id) ?? null;
    if (attemptMs !== null && attemptMs > opts.nowMs - retry[mode]) { skip("retry_window"); continue; }
    picked.push({ row: { id: s.id, name: s.name ?? "", homepage, mode, fields }, attemptMs: attemptMs ?? 0 });
  }
  // Stable sort: creation order breaks the ties.
  picked.sort((a, b) => a.attemptMs - b.attemptMs);
  return { considered: snaps.length, eligible: picked.map((p) => p.row), skipped };
}

// ─── One profile ───────────────────────────────────────────────────────────

export interface OwnerRefreshDeps {
  /** The about judges (tests: stubs); default the real ones (or the test override). Each call is noted on the run's LLM meter. */
  aboutJudges?: HcrAboutJudges;
  /** fetch seam for the homepage fetch (the SSRF guard runs before it). */
  fetchImpl?: typeof fetch;
}

export interface OwnerRefreshWriteResult {
  written: Array<{ field: OwnerRefreshField; old_value: string | null; new_value: string }>;
  refused: Array<{ field: string; reason: string }>;
}

export interface OwnerRefreshRowOutcome {
  /** written | unchanged | hijacked | fetch_failed | failed | timeout | no_homepage */
  outcome: string;
  written: OwnerRefreshField[];
  refused: Array<{ field: string; reason: string }>;
  /** Says nothing about the profile (deadline, a transient fetch failure): not stamped, tried again next night. */
  transient?: boolean;
  detail?: string;
}

function meteredJudges(base: HcrAboutJudges): HcrAboutJudges {
  return {
    quality: (c, n, io) => { noteLlmCall(OWNER_REFRESH_JUDGE_SOURCE); return base.quality(c, n, io); },
    facts: (p, io) => { noteLlmCall(OWNER_REFRESH_JUDGE_SOURCE); return base.facts(p, io); },
    comparison: (p, io) => { noteLlmCall(OWNER_REFRESH_JUDGE_SOURCE); return base.comparison(p, io); },
    ...(base.timeoutMs !== undefined ? { timeoutMs: base.timeoutMs } : {}),
  };
}

/**
 * Refresh one owned profile: the extractor plans (dry run, limited to
 * row.fields), applyOwnerRefreshWrites writes. Never throws for a profile
 * problem; the caller has checked the write-pause and the budgets.
 */
export async function refreshOwnedProfile(
  db: Db,
  row: OwnerRefreshRow,
  opts: { deadlineAt: number; runId: string; deps?: OwnerRefreshDeps; env?: NodeJS.ProcessEnv },
): Promise<OwnerRefreshRowOutcome> {
  const targets = selectHomepageContentRefreshTargetsByIds(db, [row.id], 1);
  if (targets.length === 0) return { outcome: "no_homepage", written: [], refused: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), Math.max(0, opts.deadlineAt - Date.now()) + 250);
  });
  const raced = await Promise.race([
    refreshHomepageContent(db, targets, {
      dryRun: true,
      deadlineAt: opts.deadlineAt,
      planOnlyFields: row.fields,
      aboutJudges: meteredJudges(opts.deps?.aboutJudges ?? currentHcrAboutJudges()),
      ...(opts.deps?.fetchImpl ? { fetchImpl: opts.deps.fetchImpl } : {}),
    }),
    timedOut,
  ]).finally(() => clearTimeout(timer));
  if (raced === "timed_out") return { outcome: "timeout", written: [], refused: [], transient: true, detail: HCR_DEADLINE_EXCEEDED };
  const err = raced.errors.find((e) => e.agent_id === row.id)?.error;
  if (err?.startsWith(HCR_DEADLINE_EXCEEDED)) return { outcome: "timeout", written: [], refused: [], transient: true, detail: HCR_DEADLINE_EXCEEDED };
  // A hijacked / lapsed domain is not the owner's source: nothing at all.
  const spamCandidate = raced.skipped_unsubstantiated.some((s) => s.agent_id === row.id && s.reason === HCR_THEME_SPAM_CANDIDATE_REASON);
  if (err?.startsWith(HCR_THEME_SPAM_PAGE_ERROR) || spamCandidate) {
    return { outcome: "hijacked", written: [], refused: [], detail: HCR_THEME_SPAM_PAGE_ERROR };
  }
  // A dead or blocked site is a real outcome (stamped: the retry window
  // applies); a transient one (timeout, 5xx, 429 …) is tried again next night.
  if (err) {
    const fetchFailed = err.startsWith("fetch_failed");
    return {
      outcome: fetchFailed ? "fetch_failed" : "failed", written: [], refused: [], detail: err.slice(0, 200),
      ...(!fetchFailed || err.includes("(transient)") ? { transient: true } : {}),
    };
  }
  const planned = (raced.planned_writes ?? []).filter((p) => p.agent_id === row.id);
  if (planned.length === 0) return { outcome: "unchanged", written: [], refused: [] };
  const r = applyOwnerRefreshWrites(db, row.id, planned, { runId: opts.runId, env: opts.env });
  return {
    outcome: r.written.length > 0 ? "written" : "unchanged",
    written: r.written.map((w) => w.field),
    refused: r.refused,
  };
}

/** Why one planned write may not be made now (null = write it). */
function writeRefusal(
  p: HcrPlannedWrite,
  wanted: ReadonlySet<string>,
  aboutWritten: boolean,
): string | null {
  if (OWNER_REFRESH_NEVER_FIELDS.includes(p.field)) return "never_field";
  if (!(OWNER_REFRESH_FIELDS as readonly string[]).includes(p.field)) return "not_allowed";
  if (TABLE_OF[p.field as OwnerRefreshField] !== p.table) return "not_allowed";
  if (!wanted.has(p.field)) return "not_wanted";
  if (p.field === "description" && !aboutWritten) return "description_without_about";
  if (p.field !== "categories") {
    if (typeof p.column_value !== "string" || p.column_value.trim() === "") return "empty_value";
    if (containsOrganicClaim(p.column_value)) return "organic_claim";
  }
  return null;
}

/**
 * Writes the extractor's planned writes for one owned profile, in one
 * transaction, after re-reading the row and the owner's choice (both may
 * have changed while the page was fetched and judged). See the header for
 * the rules. Exported for the tests.
 */
export function applyOwnerRefreshWrites(
  db: Db,
  agentId: string,
  planned: readonly HcrPlannedWrite[],
  ctx: { runId: string; env?: NodeJS.ProcessEnv; now?: Date },
): OwnerRefreshWriteResult {
  const result: OwnerRefreshWriteResult = { written: [], refused: [] };
  const env = ctx.env ?? process.env;
  const order = (f: string) => { const i = (OWNER_REFRESH_FIELDS as readonly string[]).indexOf(f); return i < 0 ? 99 : i; };
  const sorted = [...planned].sort((a, b) => order(a.field) - order(b.field));
  db.transaction(() => {
    const snap = loadSnapshot(db, agentId);
    const mode = snap ? ownerRefreshModes(db, [agentId], env).get(agentId) ?? null : null;
    if (!snap || !mode) {
      for (const p of sorted) result.refused.push({ field: p.field, reason: snap ? "choice_never" : "not_owned" });
      return;
    }
    const wanted = new Set<string>(plannedOwnerRefreshFields(snap, mode));
    const ownerLocks = ownerLockedFieldKeys(snap.curated_fields);
    const nowIso = (ctx.now ?? new Date()).toISOString();
    const incoming: Record<string, { sources: Array<HcrPlannedWrite["provenance"]> }> = {};
    const audit = db.prepare(
      `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)`,
    );
    let aboutWritten = false;
    for (const p of sorted) {
      const why = writeRefusal(p, wanted, aboutWritten);
      if (why) { result.refused.push({ field: p.field, reason: why }); continue; }
      const field = p.field as OwnerRefreshField;
      let oldValue: string | null;
      let newValue: string;
      let provenanceValue = p.provenance.value;
      if (field === "about") {
        // Through the owner lock, also with OWNER_LOCK_ENFORCE_WRITES off.
        const r = knowledgeService.upsertKnowledge(agentId, { about: String(p.column_value) }, { enforceOwnerLock: true });
        if (r.skipped.some((x) => x.field === "about")) { result.refused.push({ field, reason: "owner_locked" }); continue; }
        oldValue = snap.about;
        newValue = String(p.column_value);
        aboutWritten = true;
      } else {
        // agents.description / agents.categories: the same owner-lock rule.
        if (ownerLocks.has(field)) { result.refused.push({ field, reason: "owner_locked" }); continue; }
        if (field === "description") {
          newValue = String(p.column_value);
          oldValue = snap.description;
        } else {
          let list: unknown;
          try { list = JSON.parse(String(p.column_value)); } catch { list = null; }
          const cats = Array.isArray(list) ? stripOrganicCategories(list.map((c) => String(c))) : [];
          if (!Array.isArray(list) || cats.length === 0) {
            result.refused.push({ field, reason: Array.isArray(list) && list.length > 0 ? "organic_claim" : "empty_value" });
            continue;
          }
          newValue = JSON.stringify(cats);
          provenanceValue = cats.join(",");
          oldValue = snap.categories;
        }
        db.prepare(`UPDATE agents SET ${field === "description" ? "description" : "categories"} = ? WHERE id = ?`).run(newValue, agentId);
      }
      incoming[field] = { sources: [{ ...p.provenance, value: provenanceValue }] };
      audit.run(
        `audit_${randomBytes(8).toString("hex")}`,
        agentId, field, oldValue, newValue, nowIso,
        `auto.updates=${mode}; kilde=${p.provenance.source_type} ${p.provenance.source_url}; ${ctx.runId}`.slice(0, 490),
      );
      result.written.push({ field, old_value: oldValue, new_value: newValue });
    }
    if (result.written.length === 0) return;
    // The provenance record the extractor would have merged (re-read: the
    // about write above rewrote the row).
    const cur = db.prepare(`SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as { field_provenance: string | null } | undefined;
    if (!cur) db.prepare(`INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)`).run(agentId, nowIso);
    const merged = mergeFieldProvenance(parseObject(cur?.field_provenance) ?? {}, incoming);
    db.prepare(`UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?`).run(JSON.stringify(merged), nowIso, agentId);
  })();
  return result;
}

// ─── Reports ───────────────────────────────────────────────────────────────

export interface OwnerRefreshStepReport {
  cap: number;
  considered: number;
  eligible: number;
  selected: number;
  attempted: number;
  /** Profiles with at least one field written. */
  written: number;
  fields_written: Record<string, number>;
  refused: Record<string, number>;
  outcomes: Record<string, number>;
  skipped_before_selection: Record<string, number>;
  skipped_reason: string | null;
  stopped_reason: string | null;
  llm_calls: number;
  llm_calls_per_row_max: number;
  est_cost_usd: number;
  changed_agent_ids: string[];
  rows: Array<{ agent_id: string; mode: OwnerAutoUpdatesMode; outcome: string; written?: string[]; detail?: string }>;
  duration_ms: number;
  errors: string[];
}

export function newOwnerRefreshStepReport(cap: number): OwnerRefreshStepReport {
  return {
    cap, considered: 0, eligible: 0, selected: 0, attempted: 0, written: 0,
    fields_written: {}, refused: {}, outcomes: {}, skipped_before_selection: {},
    skipped_reason: null, stopped_reason: null, llm_calls: 0,
    llm_calls_per_row_max: OWNER_REFRESH_JUDGE_CALLS_PER_PASS * (isEnrichmentAboutPageEnabled() ? 2 : 1),
    est_cost_usd: 0, changed_agent_ids: [], rows: [], duration_ms: 0, errors: [],
  };
}

/** One row's outcome into the step report. */
export function tallyOwnerRefreshRow(sr: OwnerRefreshStepReport, row: OwnerRefreshRow, out: OwnerRefreshRowOutcome): void {
  sr.attempted++;
  sr.outcomes[out.outcome] = (sr.outcomes[out.outcome] ?? 0) + 1;
  if (out.written.length > 0) {
    sr.written++;
    sr.changed_agent_ids.push(row.id);
  }
  for (const f of out.written) sr.fields_written[f] = (sr.fields_written[f] ?? 0) + 1;
  for (const r of out.refused) sr.refused[r.reason] = (sr.refused[r.reason] ?? 0) + 1;
  sr.rows.push({
    agent_id: row.id, mode: row.mode, outcome: out.outcome,
    ...(out.written.length > 0 ? { written: out.written } : {}),
    ...(out.detail ? { detail: out.detail.slice(0, 200) } : {}),
  });
}

/** The dry-run view: who the refresh would take tonight, with which choice and fields. Read-only. */
export interface OwnerRefreshPreview {
  enabled_by_env: boolean;
  cap: number;
  considered: number;
  eligible: number;
  selected_ids: string[];
  /** Every due profile (at most 100): its choice and the fields the refresh may write. */
  rows: Array<{ agent_id: string; mode: OwnerAutoUpdatesMode; fields: OwnerRefreshField[]; selected: boolean }>;
  skipped: Record<string, number>;
  llm_calls_per_row_max: number;
}

export async function buildOwnerRefreshPreview(
  db: Db,
  opts: OwnerRefreshCohortOptions & { cap: number },
): Promise<OwnerRefreshPreview> {
  const cohort = await loadOwnerRefreshCohort(db, opts);
  const selected = new Set(cohort.eligible.slice(0, Math.max(0, opts.cap)).map((r) => r.id));
  return {
    enabled_by_env: ownerAutoUpdatesEnabled(opts.env ?? process.env),
    cap: opts.cap,
    considered: cohort.considered,
    eligible: cohort.eligible.length,
    selected_ids: [...selected],
    rows: cohort.eligible.slice(0, 100).map((r) => ({ agent_id: r.id, mode: r.mode, fields: r.fields, selected: selected.has(r.id) })),
    skipped: cohort.skipped,
    llm_calls_per_row_max: OWNER_REFRESH_JUDGE_CALLS_PER_PASS * (isEnrichmentAboutPageEnabled() ? 2 : 1),
  };
}
