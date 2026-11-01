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
//   • fill_empty: only a field that is empty now. automatic: also a filled
//     about / description, but ONLY when field_provenance[field] holds a
//     non-owner record whose value is the column's current text (the stored
//     text is provably ours) and the owner never wrote the profile
//     (data_source owner/hybrid, owner_updated_at set); otherwise automatic
//     is exactly fill_empty. Never a field the owner saved (curated_fields
//     by owner, an `owner` provenance record) or customer service locked (any
//     curated_fields entry); about and description go together and are left
//     alone when either is locked. NB fill_empty refills an about the owner
//     emptied in /selger: that editor leaves no per-field trace, and the
//     spec's «fyll tomme felt» covers every empty field (per spec);
//   • no prose with an organic or certification claim, an e-mail address or
//     a price (ownerRefreshProseRefusal), no organic category (whatever the
//     Debio status — the owner states those, we do not);
//   • `about` through knowledgeService.upsertKnowledge with the owner lock
//     forced on (enforceOwnerLock, also with OWNER_LOCK_ENFORCE_WRITES off);
//     agents.description / agents.categories behind the same owner-lock rule
//     (ownerLockedFieldKeys);
//   • one agent_knowledge_audit row per written field (changed_by 'system',
//     notes with the choice, the source and its URL, the run id): the owner
//     sees it in the portal's «Endringslogg» (GET /api/agents/:id/my-audit);
//   • the website_homepage provenance record merged as the extractor would.
// What else changes on an owned profile when something is written: the
// `about` write goes through upsertKnowledge, which rewrites the whole
// agent_knowledge row as it always does — last_enriched_at and updated_at
// are set, agents.agent_version is bumped, and the JSON columns are
// re-serialised from their parsed values (normalised, same content); the
// merged provenance sets field_provenance and updated_at. Nothing else: no
// fetch bookkeeping, no parking, no rotation stamp on agent_knowledge, no
// review-queue proposal.
//
// Failures: a dead / blocked site, a hijacked page, a failed write or any
// other non-fetch failure is a real outcome (stamped; due again after the
// fill_empty retry window, whatever the choice). Only a transient fetch
// failure, the deadline and an unavailable about judge (API outage) are
// transient: not stamped, tried again the next night.
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
  HCR_ABOUT_REASON_JUDGE_UNAVAILABLE,
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
  /** Set by every owner write through /selger or the knowledge PUT (ownerUpdate); kept by later non-owner writes. */
  owner_updated_at?: string | null;
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
           k.owner_updated_at AS owner_updated_at, k.homepage_unreachable_since AS homepage_unreachable_since
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
    owner_updated_at: r.owner_updated_at ?? null,
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

/** The records of field_provenance[field], whatever the stored shape (list, {sources}, a single record). */
function provenanceRecords(prov: Record<string, unknown>, field: string): unknown[] {
  const v = prov[field];
  return Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { sources?: unknown }).sources) ? (v as { sources: unknown[] }).sources : v ? [v] : [];
}

function sourceTypeOf(r: unknown): string {
  const st = r && typeof r === "object" ? (r as { source_type?: unknown }).source_type : null;
  return typeof st === "string" ? st.trim().toLowerCase() : "";
}

/** field_provenance[field] carries an owner-attested record (source_type «owner», the gate's Tier S). */
function ownerAttested(prov: Record<string, unknown>, field: string): boolean {
  return provenanceRecords(prov, field).some((r) => sourceTypeOf(r).split(":")[0] === "owner");
}

/** Whitespace-collapsed and trimmed: «is the stored text the text a source gave?» */
function normText(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The column's current text is provably ours: field_provenance[field] holds
 * a record from a non-owner source (not «owner…») whose value IS that text.
 * A text the owner wrote by any path that leaves no record (PUT
 * /agents/:id/description, /register, a CS correction) never matches.
 */
function storedTextIsOurs(prov: Record<string, unknown>, field: string, current: string | null): boolean {
  const cur = normText(current);
  if (cur === "") return false;
  return provenanceRecords(prov, field).some((r) => {
    const st = sourceTypeOf(r);
    const value = r && typeof r === "object" ? (r as { value?: unknown }).value : null;
    return st !== "" && !st.startsWith("owner") && typeof value === "string" && normText(value) === cur;
  });
}

/**
 * The fields this owner's choice lets the refresh write for this profile
 * now (the extractor is limited to them). Empty = nothing to do.
 *   locked   any curated_fields entry (an owner save stamps by:"owner",
 *            customer service its own name) or an owner provenance record;
 *            unreadable curated_fields / field_provenance → nothing (fail closed)
 *   empty    fill_empty writes only an empty field (also one the owner
 *            emptied in /selger — no per-field trace; per spec). automatic
 *            also a filled about / description, but only when its text is
 *            provably ours (storedTextIsOurs) and the owner never wrote the
 *            profile (data_source owner/hybrid or owner_updated_at set: the
 *            /selger editor and the knowledge PUT leave no per-field trace);
 *            otherwise automatic is exactly fill_empty
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
  const ownerWroteProfile = s.data_source === "owner" || s.data_source === "hybrid" || !!s.owner_updated_at;
  const may = (f: "about" | "description", current: string | null) =>
    !locked(f) && (blankText(current) || (mode === "automatic" && !ownerWroteProfile && storedTextIsOurs(prov, f, current)));
  const out: OwnerRefreshField[] = [];
  if (!locked("about") && !locked("description") && may("about", s.about)) {
    out.push("about");
    if (may("description", s.description)) out.push("description");
  }
  if (!locked("categories") && blankList(s.categories)) out.push("categories");
  return out;
}

// ─── Claims an owner states, never us ──────────────────────────────────────
// Spec «Skriver aldri»: organic / certification claims, e-mail addresses,
// prices. Checked on every about / description text before it is written
// (owned profiles only — the nightly's unowned steps are unchanged).

/** Organic words the shared list (containsOrganicClaim) leaves out: bio / eco / ecological(ly) as words, also «bio-…» / «eco-…»; not «biologi», «biografi». */
const EXTRA_ORGANIC_RE = /(?:^|[^\p{L}\p{N}])(?:bio|eco|ecological|ecologically)(?=$|[^\p{L}\p{N}])/iu;
/** Certification marks: Nyt Norge, Spesialitet (the mark, capitalised), the protected designations. */
const CERTIFICATION_MARK_RES: readonly RegExp[] = [
  /nyt\s+norge/iu,
  /(?:^|[^\p{L}])Spesialitet(?=$|[^\p{L}])/u,
  /spesialitetsmerke/iu,
  /beskyttet\s+(?:geografisk\s+betegnelse|opprinnelsesbetegnelse|tradisjonelt\s+særpreg)/iu,
  /protected\s+(?:geographical\s+indication|designation\s+of\s+origin)/iu,
];
const EMAIL_RE = /[^\s@<>()"']+@[^\s@<>()"']+\.\p{L}{2,}/u;
/** «kr 120», «kr. 120», «NOK 120», «120 kr», «1 200 kroner», «120,50 NOK», «120,-». */
const PRICE_RES: readonly RegExp[] = [
  /(?:^|[^\p{L}])(?:kr|nok)\.?\s*\d/iu,
  /\d\s*(?:kr|kroner|nok)(?=$|[^\p{L}])/iu,
  /\d\s*,-/u,
];

/** Why an about / description text may not be written for an owner (null = it may). */
export function ownerRefreshProseRefusal(text: string): "organic_claim" | "certification_claim" | "email_address" | "price" | null {
  if (containsOrganicClaim(text) || EXTRA_ORGANIC_RE.test(text)) return "organic_claim";
  if (CERTIFICATION_MARK_RES.some((re) => re.test(text))) return "certification_claim";
  if (EMAIL_RE.test(text)) return "email_address";
  if (PRICE_RES.some((re) => re.test(text))) return "price";
  return null;
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

/** Outcomes after which an «automatic» profile is due again the next night; any other stamped outcome waits the fill_empty window. */
const OWNER_REFRESH_NIGHTLY_OUTCOMES: ReadonlySet<string> = new Set(["written", "unchanged"]);

/** The rotation memory (step owner_refresh): agent_id → last attempt (ms) and its outcome. No table → empty. */
export function readOwnerRefreshAttempts(db: Db): Map<string, { at: number; outcome: string | null }> {
  const out = new Map<string, { at: number; outcome: string | null }>();
  let rows: Array<{ agent_id: string; last_attempted_at: string; last_outcome: string | null }> = [];
  try {
    rows = db
      .prepare(`SELECT agent_id, last_attempted_at, last_outcome FROM rfb_enrichment_nightly_attempts WHERE step = ?`)
      .all(OWNER_REFRESH_STEP) as typeof rows;
  } catch {
    return out;
  }
  for (const r of rows) {
    const at = Date.parse(r.last_attempted_at);
    if (!Number.isNaN(at)) out.set(r.agent_id, { at, outcome: r.last_outcome ?? null });
  }
  return out;
}

/** Owned profiles the refresh would take now. Read-only; yields every 200 rows. */
export async function loadOwnerRefreshCohort(db: Db, opts: OwnerRefreshCohortOptions): Promise<OwnerRefreshCohort> {
  const env = opts.env ?? process.env;
  const snaps = (db.prepare(snapshotSql()).all() as any[]).map(toSnapshot);
  await yieldToEventLoop();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const modes = ownerAutoUpdatesEnabled(env) ? resolveModes(db, snaps.map((s) => s.id), env) : new Map<string, OwnerAutoUpdatesMode | null>();
  const last = readOwnerRefreshAttempts(db);
  const fillEmptyRetryMs = opts.fillEmptyRetryMs ?? OWNER_REFRESH_FILL_EMPTY_RETRY_MS_DEFAULT;
  // automatic is due every night after a real refresh; after a failure
  // (dead site, failed write …) every choice waits the fill_empty window.
  const retryMs = (mode: OwnerAutoUpdatesMode, outcome: string | null) =>
    mode === "automatic" && OWNER_REFRESH_NIGHTLY_OUTCOMES.has(outcome ?? "") ? OWNER_REFRESH_AUTOMATIC_RETRY_MS : fillEmptyRetryMs;
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
    const prev = last.get(s.id) ?? null;
    const attemptMs = prev ? prev.at : null;
    if (prev && prev.at > opts.nowMs - retryMs(mode, prev.outcome)) { skip("retry_window"); continue; }
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
  /** written | unchanged | judge_unavailable | hijacked | fetch_failed | write_failed | failed | timeout | no_homepage */
  outcome: string;
  written: OwnerRefreshField[];
  refused: Array<{ field: string; reason: string }>;
  /** Says nothing about the profile (deadline, a transient fetch failure, an unavailable about judge): not stamped, tried again next night. */
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
  let raced: Awaited<ReturnType<typeof refreshHomepageContent>> | "timed_out";
  try {
    raced = await Promise.race([
    refreshHomepageContent(db, targets, {
      dryRun: true,
      deadlineAt: opts.deadlineAt,
      planOnlyFields: row.fields,
      aboutJudges: meteredJudges(opts.deps?.aboutJudges ?? currentHcrAboutJudges()),
      ...(opts.deps?.fetchImpl ? { fetchImpl: opts.deps.fetchImpl } : {}),
    }),
    timedOut,
  ]).finally(() => clearTimeout(timer));
  } catch (err) {
    // An unexpected throw in the extractor: a real outcome (stamped), not retried every night.
    return { outcome: "failed", written: [], refused: [], detail: `refresh threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
  }
  if (raced === "timed_out") return { outcome: "timeout", written: [], refused: [], transient: true, detail: HCR_DEADLINE_EXCEEDED };
  const err = raced.errors.find((e) => e.agent_id === row.id)?.error;
  if (err?.startsWith(HCR_DEADLINE_EXCEEDED)) return { outcome: "timeout", written: [], refused: [], transient: true, detail: HCR_DEADLINE_EXCEEDED };
  // A hijacked / lapsed domain is not the owner's source: nothing at all.
  const spamCandidate = raced.skipped_unsubstantiated.some((s) => s.agent_id === row.id && s.reason === HCR_THEME_SPAM_CANDIDATE_REASON);
  if (err?.startsWith(HCR_THEME_SPAM_PAGE_ERROR) || spamCandidate) {
    return { outcome: "hijacked", written: [], refused: [], detail: HCR_THEME_SPAM_PAGE_ERROR };
  }
  // A dead or blocked site and any other failure are real outcomes (stamped:
  // the retry window applies); only a transient fetch failure (timeout, 5xx,
  // 429 …) is tried again next night.
  if (err) {
    const fetchFailed = err.startsWith("fetch_failed");
    return {
      outcome: fetchFailed ? "fetch_failed" : "failed", written: [], refused: [], detail: err.slice(0, 200),
      ...(fetchFailed && err.includes("(transient)") ? { transient: true } : {}),
    };
  }
  // An about judge that could not answer (API outage, missing key): the
  // about is undecided, so the profile is tried again next night.
  const judgeUnavailable = raced.skipped_unsubstantiated.some((x) => x.agent_id === row.id && x.reason === HCR_ABOUT_REASON_JUDGE_UNAVAILABLE);
  const undecided = judgeUnavailable ? { transient: true, detail: HCR_ABOUT_REASON_JUDGE_UNAVAILABLE } : {};
  const planned = (raced.planned_writes ?? []).filter((p) => p.agent_id === row.id);
  if (planned.length === 0) return { outcome: judgeUnavailable ? "judge_unavailable" : "unchanged", written: [], refused: [], ...undecided };
  let r: OwnerRefreshWriteResult;
  try {
    r = applyOwnerRefreshWrites(db, row.id, planned, { runId: opts.runId, env: opts.env });
  } catch (e) {
    // The transaction rolled back. A real outcome: stamped, not retried (with its judge calls) every night.
    return { outcome: "write_failed", written: [], refused: [], detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
  return {
    outcome: r.written.length > 0 ? "written" : judgeUnavailable ? "judge_unavailable" : "unchanged",
    written: r.written.map((w) => w.field),
    refused: r.refused,
    ...undecided,
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
    const prose = ownerRefreshProseRefusal(p.column_value);
    if (prose) return prose;
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
