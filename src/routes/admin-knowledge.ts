// ─── Admin Knowledge endpoint — PR-24 (2026-05-11) ──────────────
//
// PUT /admin/knowledge — enrichment surface used by lokal-agent-enrichment
// (a Cowork scheduled task) to write the agent_knowledge profile during
// the Phase 2D crawl.
//
// Why this endpoint exists (PR-24):
//   Pool was frozen at 129 since 2026-05-05 because enrichment writes
//   agent_knowledge (about / products / openingHours / address / phone)
//   but did NOT update `field_provenance`. The WO-16 cross-source gate
//   in src/services/cross-source-validator.ts requires source_count >= 2
//   on address/phone/business_status. Without provenance entries, every
//   newly-enriched agent fails the gate.
//
//   The verifier never writes provenance (it only reads). The enrichment
//   SKILL must populate it on every crawl-write. This route is the
//   surface the SKILL PUTs into.
//
// Shape that the validator (cross-source-validator.ts) reads from disk:
//   field_provenance = {
//     <field>: ProvenanceRecord[]
//   }
//   ProvenanceRecord = { value, source_type, source_url?, fetched_at }
//
// Wire-shape this endpoint accepts (two flavours, both normalised in):
//   1. Wrapped:
//        { address: { sources: [{source_type, captured_at, raw_value}, ...] } }
//      Matches the SKILL-addendum example written for the enrichment-agent.
//   2. Flat array (matches on-disk shape):
//        { address: [{value, source_type, fetched_at, source_url?}, ...] }
//      Matches what the validator reads. Either works.
//
// Merge semantics:
//   - For each tracked field, append new sources to the existing array.
//   - Dedupe by {source_type, normalised value}: same pair = no-op.
//   - Untouched fields preserve existing provenance.
//   - Untouched columns (about, products, ...) preserve existing values.
//
// PR-28 (2026-05-11): defensive handling of malformed existing
// field_provenance. The phase51_backfill_provenance_v1 migration writes
// records WITHOUT a `value` field (only source_type/source_url/
// confidence/fetched_at). phase53_provenance_to_array_v1 then wraps
// those legacy single-objects in a 1-element array. When this route
// loaded such an entry and called `mergeFieldProvenance` → `dedupKey`,
// `rec.value.trim()` threw on `undefined.trim()`, the error escaped the
// route's try/catch (which only wrapped tx()), and express's default
// handler returned plain-HTML 500 — breaking enrichment for address/
// phone on any agent touched by the back-catalogue migrations. We now
// (1) skip malformed records on the way in, (2) guard dedupKey against
// undefined, and (3) wrap mergeFieldProvenance + parse in try/catch so
// any unexpected shape returns a 500 JSON instead of crashing express.
//
// orch-pr-17 (2026-06-15): SAFE correct-not-just-add. Opt-in via
// ?allow_correct=1 (or body { allow_correct: true }). When ON, a factual
// column (products/address/phone/about) that would OVERWRITE a populated,
// differing legacy value is gated by canCorrectFactualField(): allowed ONLY
// when the existing value is known-bad legacy (inference-only provenance OR
// website_ownership=unverified) AND the new value has >=2 Tier-A sources or
// is owner-attested (Tier-S); never when the field is curated/locked, the
// existing value already has >=2 Tier-A, or the new value is inference-sourced.
// Unsafe overwrites are dropped (legacy preserved) and reported in
// response.corrections. Default OFF leaves write behaviour byte-for-byte unchanged.
//
// PR-A (2026-06-16): homepage-preferred CONTENT writes + provenance.
//   - canCorrectFactualField now lets a SINGLE website_homepage source overwrite
//     google_places content for the CONTENT fields (about/products/description/
//     categories) — the homepage is owner-published, the highest-trust source
//     for what a producer is/sells (fixes the wrong business-type/products
//     complaints). The curated_locked refusal stays the FIRST, ABSOLUTE check, so
//     a CS/owner-locked field is never overwritten. All existing google_places-
//     vs-google_places math is unchanged.
//   - PUT /admin/knowledge now also accepts + writes description/categories,
//     which live on the `agents` table (not agent_knowledge), in the SAME
//     transaction (additive, backward-compatible). field_provenance for all four
//     content fields is recorded via the existing mergeFieldProvenance (the same
//     provenance mechanism the /admin/homepage-provenance-batch endpoint uses),
//     with source_type:"website_homepage", source_url, fetched_at supplied by the
//     caller. No schema migration — provenance rides the existing JSON column.
//
// Auth: X-Admin-Key (same pattern as admin-outreach-pool).
//
// Reference:
//   - PR-23: parallel backfill for stranded back-catalogue (different file).
//   - PR-28: this defensive-coding fix.
//   - WO-16: source of the cross-source gate.
//   - scheduled-agents/lokal-agent-enrichment-field-provenance-addendum.md
//     (A2A repo) — SKILL update that makes use of this endpoint.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { isDirectoryOrAggregatorHost } from "../services/cross-source-validator";
// dev-request 2026-07-01-cs-corrections-profile-quality item C: reuse the
// render-time repair logic as the one-time DB backfill/cleanup function —
// see the truncation-sweep router at the bottom of this file.
import { safeMetaDescription } from "./seo";
// PR-24a: homepage CONTENT extractors (PR-22) + write helpers (PURE).
import {
  isSafeFetchUrl,
  extractVisibleText,
  extractBusinessTypeTokens,
  extractProductMentions,
  summarizeAbout,
  mapToPlatformCategories,
  meetsAboutQualityBar,
} from "../services/search-enrich";

const router = Router();

// ─── Auth helper (mirrors admin-outreach-pool.ts pattern) ─────────────
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

// ─── Shape & merge logic for field_provenance ──────────────────────────

// On-disk shape (matches cross-source-validator.ProvenanceRecord)
type ProvenanceRecord = {
  value: string;
  source_type: string;
  source_url?: string;
  fetched_at: string;
};

// Wire-shape — the enrichment SKILL may emit either flat array or wrapped
// {sources:[...]} per field. Each source may use {raw_value, captured_at}
// (the convention used in the SKILL doc) or {value, fetched_at} (the
// on-disk names). We accept both and normalise.
type IncomingSource = {
  source_type?: string;
  value?: string;
  raw_value?: string;
  fetched_at?: string;
  captured_at?: string;
  source_url?: string;
};
type IncomingFieldEntry = IncomingSource[] | { sources?: IncomingSource[] };
type IncomingProvenance = Record<string, IncomingFieldEntry>;

function normaliseSource(s: IncomingSource): ProvenanceRecord | null {
  const source_type = (s.source_type ?? "").toString().trim();
  if (!source_type) return null;
  const value = (s.value ?? s.raw_value ?? "").toString();
  // Reject sources that carry no value — the validator filters them out
  // anyway, so storing them would just be noise.
  if (!value || !value.trim()) return null;
  const fetched_at = (s.fetched_at ?? s.captured_at ?? new Date().toISOString()).toString();
  const rec: ProvenanceRecord = { value, source_type, fetched_at };
  if (s.source_url) rec.source_url = String(s.source_url);
  return rec;
}

function extractSources(entry: IncomingFieldEntry): IncomingSource[] {
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === "object" && Array.isArray((entry as any).sources)) {
    return (entry as { sources: IncomingSource[] }).sources;
  }
  return [];
}

// Dedupe key — same source_type and same trimmed value = same source.
// Intentionally pragmatic: the cross-source validator normalises
// per-field (phone strips +47 etc), but for dedup purposes the raw
// `${source_type}::${value.trim()}` pair is precise enough to avoid
// double-counting on repeat enrichment runs.
//
// PR-28: tolerates malformed records — if value or source_type is
// missing/non-string, returns null. Callers MUST treat null as "skip
// this record" (don't add to seen-set, don't include in output).
export function dedupKey(rec: ProvenanceRecord | null | undefined): string | null {
  if (!rec || typeof rec !== "object") return null;
  const st = rec.source_type;
  const v = rec.value;
  if (typeof st !== "string" || st.length === 0) return null;
  if (typeof v !== "string") return null;
  return `${st}::${v.trim()}`;
}

// PR-28: a record loaded from disk is "well-formed" only if both
// source_type and value are non-empty strings. Anything else is dropped
// before the merge so the rest of the merge pipeline can assume the
// invariant. Mirrors the validator's downstream filter.
function isWellFormedRecord(r: unknown): r is ProvenanceRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  if (typeof o.source_type !== "string" || o.source_type.trim().length === 0) return false;
  if (typeof o.value !== "string" || o.value.trim().length === 0) return false;
  return true;
}

/**
 * Merge an incoming field_provenance payload into an existing on-disk
 * field_provenance object. Pure function — exported for unit-testing.
 *
 * PR-28: malformed existing records (missing value or source_type — as
 * produced by the phase51 backfill migration) are filtered out instead
 * of being carried forward. The route handler will overwrite the column
 * with the cleaned shape on the next provenance write.
 *
 * @param existing parsed JSON from agent_knowledge.field_provenance (may be {})
 * @param incoming wire-shape payload (wrapped or flat per field)
 * @returns merged on-disk shape
 */
export function mergeFieldProvenance(
  existing: Record<string, unknown>,
  incoming: IncomingProvenance,
): Record<string, ProvenanceRecord[]> {
  // Start from a shallow copy of existing — coerce legacy single-record
  // shape into arrays, then drop malformed entries (PR-28 defensive
  // coding for back-catalogue rows from phase51 backfill).
  const out: Record<string, ProvenanceRecord[]> = {};
  for (const [field, val] of Object.entries(existing)) {
    let arr: unknown[];
    if (Array.isArray(val)) {
      arr = val.slice();
    } else if (val && typeof val === "object") {
      // Legacy single-record shape (pre-WO-16) → wrap in array.
      arr = [val];
    } else {
      // null / primitives → drop (mirrors validator behaviour).
      continue;
    }
    // PR-28: filter out malformed records before they reach dedupKey.
    out[field] = arr.filter(isWellFormedRecord);
  }

  for (const [field, entry] of Object.entries(incoming)) {
    const incomingSources = extractSources(entry);
    if (incomingSources.length === 0) continue;
    const existingForField = out[field] ?? [];
    // Seed seen-set from well-formed existing records. dedupKey now
    // returns null on malformed inputs — they were already filtered
    // above, but the null-guard keeps belt-and-braces.
    const seen = new Set<string>();
    for (const r of existingForField) {
      const k = dedupKey(r);
      if (k !== null) seen.add(k);
    }
    for (const s of incomingSources) {
      const rec = normaliseSource(s);
      if (!rec) continue;
      const key = dedupKey(rec);
      if (key === null) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      existingForField.push(rec);
    }
    out[field] = existingForField;
  }

  return out;
}

// ─── orch-pr-17: SAFE "correct-not-just-add" overwrite guard ─────────────────
//
// Enrichment is additive by default — it fills MISSING factual fields but never
// overwrites a populated legacy value, so a *wrong* legacy value (e.g. a product
// list fabricated from category_inference, or contact data scraped off a
// wrong-entity site) persists forever. This guard adds a narrowly-scoped,
// OPT-IN ("?allow_correct=1" / body { allow_correct: true }) overwrite path for
// the factual fields products / address / phone / about.
//
// A factual field's populated legacy value MAY be overwritten ONLY when BOTH:
//   (1) the EXISTING value is KNOWN-BAD legacy — its provenance is inference-only
//       (no real Tier-A/B/S source, just category_inference / seasonal_knowledge
//       / name_analysis / web_search), OR the producer's website was flagged
//       website_ownership.status == "unverified" (wrong-entity), AND
//   (2) the NEW value is well-sourced — >=2 distinct Tier-A sources
//       (homepage + google_places) agree, OR it is owner-attested (Tier-S).
//
// And NEVER overwrite when ANY of these hold (hard refusals, checked first):
//   - the field is owner-curated / locked (curatedFields[field]).
//   - the existing value already has >=2 distinct Tier-A sources (already
//     well-sourced — not "known-bad legacy").
//   - the NEW value is inference-sourced (its incoming provenance carries no
//     Tier-A/Tier-S evidence — only inference guesses).
//
// Default OFF: without the opt-in flag this guard never runs and the endpoint's
// column-write behaviour is byte-for-byte unchanged. The guard also only ever
// REMOVES an unsafe overwrite from the write set — it never adds or fabricates a
// write — so the worst case is "legacy value preserved", never data loss.

// Factual fields eligible for correction. Keyed identically in body columns and
// in field_provenance (address/phone/products/about).
export const CORRECTABLE_FACTUAL_FIELDS: readonly string[] = ["products", "address", "phone", "about"];

// Inference "source_types" that are NOT real evidence (aligned with PR-16's
// deny-list). Kept local so this guard does not depend on PR-16 being merged.
const INFERENCE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "category_inference",
  "seasonal_knowledge",
  "name_analysis",
  "name-analysis",
  "web_search",
  "web-search",
]);

// True when a provenance source_type is an AI/heuristic inference rather than
// real evidence. Matches the bare token ("web_search") and the prefixed form the
// pipeline writes ("web_search:gmail.com") — compares the part before the ':'.
export function isInferenceSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false;
  const head = String(sourceType).trim().toLowerCase().split(":")[0]!;
  return INFERENCE_SOURCE_TYPES.has(head);
}

// Tier classification for the correction guard — local + dependency-free so it
// stays aligned with the validator's TIER_A/TIER_S without importing extra
// surface. Compares the head token before ':' so "homepage:..." still counts.
const CORRECT_TIER_A: ReadonlySet<string> = new Set(["homepage", "website_homepage", "google_places"]);
const CORRECT_TIER_S: ReadonlySet<string> = new Set(["owner"]);
function correctTierHead(sourceType: string | null | undefined): string {
  return String(sourceType ?? "").trim().toLowerCase().split(":")[0]!;
}

// Count DISTINCT Tier-A source_types and detect any Tier-S record in a
// provenance array. Distinctness mirrors the validator (two homepage records do
// not count as two independent Tier-A sources). Records without a usable value
// are ignored, matching the validator's filter.
function summariseProvenance(records: unknown): {
  tierADistinct: number;
  hasTierS: boolean;
  realSourceCount: number;
  total: number;
  /** PR-A: a preferred CONTENT source present (website_homepage / owner). */
  hasPreferredContent: boolean;
  /** PR-A: at least one google_places record present. */
  hasGooglePlaces: boolean;
  /** PR-A: every usable record is google_places (no other real source). */
  googlePlacesOnly: boolean;
} {
  const tierA = new Set<string>();
  let hasTierS = false;
  let realSourceCount = 0;
  let total = 0;
  let hasPreferredContent = false;
  let hasGooglePlaces = false;
  let nonGooglePlaces = 0;
  if (Array.isArray(records)) {
    for (const r of records) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const st = typeof o.source_type === "string" ? o.source_type : "";
      const val = typeof o.value === "string" ? o.value : "";
      if (!st || !val.trim()) continue; // unusable record
      total++;
      const head = correctTierHead(st);
      if (CORRECT_TIER_S.has(head)) hasTierS = true;
      if (CORRECT_TIER_A.has(head)) tierA.add(head);
      if (!isInferenceSourceType(st)) realSourceCount++;
      if (head === "website_homepage" || head === "owner") hasPreferredContent = true;
      if (head === "google_places") hasGooglePlaces = true;
      else nonGooglePlaces++;
    }
  }
  return {
    tierADistinct: tierA.size,
    hasTierS,
    realSourceCount,
    total,
    hasPreferredContent,
    hasGooglePlaces,
    googlePlacesOnly: total > 0 && hasGooglePlaces && nonGooglePlaces === 0,
  };
}

// PR-A: CONTENT fields whose preferred source is the producer's OWN homepage.
// A single website_homepage source may overwrite google_places content for
// these (homepage = owner-published, highest trust). address/phone are NOT here
// — their cross-source agreement math is untouched.
export const CONTENT_FIELDS: readonly string[] = ["about", "products", "description", "categories"];

export type CorrectDecision = { allowed: boolean; reason: string };

/**
 * Decide whether a factual field's populated legacy value may be SAFELY
 * overwritten by an incoming value. Pure function — exported for unit-testing.
 *
 * Only call this for an OVERWRITE (existing populated value differs from the new
 * value). A pure ADD (existing field empty) is normal additive enrichment and
 * does not go through this guard.
 *
 * @param opts.field                       factual field name (products/address/phone/about)
 * @param opts.existingFieldProvenance     parsed field_provenance[field] (array) or undefined
 * @param opts.websiteOwnershipUnverified  true iff field_provenance.website_ownership.status == "unverified"
 * @param opts.incomingFieldProvenance     parsed incoming provenance[field] (array) or undefined
 * @param opts.isCurated                   true iff curatedFields[field] is set (locked)
 */
export function canCorrectFactualField(opts: {
  field: string;
  existingFieldProvenance: unknown;
  websiteOwnershipUnverified: boolean;
  incomingFieldProvenance: unknown;
  isCurated: boolean;
}): CorrectDecision {
  const { field, existingFieldProvenance, websiteOwnershipUnverified, incomingFieldProvenance, isCurated } = opts;

  const isContentField = CONTENT_FIELDS.includes(field);
  if (!CORRECTABLE_FACTUAL_FIELDS.includes(field) && !isContentField) {
    return { allowed: false, reason: "field_not_correctable" };
  }

  // ── Hard refusal #1 — ABSOLUTE, checked FIRST (PR-A keeps this first) ───────
  // Owner-curated / locked field — NEVER overwrite a CS/owner-locked field, not
  // even with a homepage source. This guards content fields too.
  if (isCurated) return { allowed: false, reason: "curated_locked" };

  const existing = summariseProvenance(existingFieldProvenance);
  const incoming = summariseProvenance(incomingFieldProvenance);

  // ── PR-A: preferred homepage CONTENT override ──────────────────────────────
  // For CONTENT fields (about/products/description/categories), a single
  // website_homepage source MAY overwrite google_places content — the homepage
  // is owner-published, the highest-trust source for what a producer is and
  // sells, so it must win over a google_places-derived value (the source of
  // today's wrong business-type/products complaints). Conditions:
  //   - field is a CONTENT field, AND
  //   - the NEW value carries a preferred content source (website_homepage/owner), AND
  //   - the EXISTING value is NOT already homepage/owner-sourced (i.e. it is
  //     google_places or weaker) — we never demote an existing homepage value.
  // The curated_locked refusal above still wins absolutely. All existing
  // google_places-vs-google_places math below is left unchanged.
  if (isContentField && incoming.hasPreferredContent && !existing.hasPreferredContent) {
    return { allowed: true, reason: "ok_homepage_preferred_over_google_places" };
  }

  // 2. Existing value already well-sourced (>=2 distinct Tier-A) — not legacy-bad.
  if (existing.tierADistinct >= 2) {
    return { allowed: false, reason: "existing_already_two_tierA" };
  }

  // 3. New value must NOT be inference-sourced — it must carry real Tier-A/Tier-S
  //    evidence. (A value whose incoming provenance has no Tier-A and no Tier-S is
  //    inference/low-trust and can never overwrite.)
  const newQualifies = incoming.tierADistinct >= 2 || incoming.hasTierS;
  if (!newQualifies) {
    return { allowed: false, reason: "new_not_two_tierA_or_owner" };
  }

  // ── Required condition (1): existing is KNOWN-BAD legacy ───────────────────
  // inference-only = it has NO real (non-inference) source, OR website ownership
  // was flagged unverified (wrong-entity). existing.total===0 (no provenance at
  // all) is NOT treated as known-bad here — that is a pure ADD, handled upstream.
  const existingInferenceOnly = existing.total > 0 && existing.realSourceCount === 0;
  const existingKnownBad = existingInferenceOnly || websiteOwnershipUnverified;
  if (!existingKnownBad) {
    return { allowed: false, reason: "existing_not_known_bad" };
  }

  // Both conditions met → safe to correct.
  return {
    allowed: true,
    reason: websiteOwnershipUnverified && !existingInferenceOnly
      ? "ok_existing_website_unverified"
      : "ok_existing_inference_only",
  };
}

// ─── Column write — body fields → agent_knowledge ──────────────────────
//
// We do the provenance update in a single transaction with the column
// upsert so partial writes don't leave the row in a half-state.

type IncomingBody = {
  agent_id?: string;
  about?: string;
  products?: unknown;
  openingHours?: unknown;
  address?: string;
  phone?: string;
  email?: string;
  postalCode?: string;
  website?: string;
  // PR-A: CONTENT fields that live on the `agents` table (not agent_knowledge).
  // Additive + backward-compatible — omitting them preserves existing values.
  // `description` is a string; `categories` is a JSON array (string[] preferred;
  // a pre-serialized JSON string is also accepted).
  description?: string;
  categories?: unknown;
  field_provenance?: IncomingProvenance;
  // orch-pr-17: opt-in flag to enable the SAFE correct-not-just-add overwrite
  // path for factual fields. Default OFF (also accepted as ?allow_correct=1).
  allow_correct?: boolean;
};

router.put("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as IncomingBody;
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!agentId) {
    res.status(400).json({ error: "agent_id required" });
    return;
  }

  const db = getDb();
  const agentRow = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId) as
    | { id: string }
    | undefined;
  if (!agentRow) {
    res.status(404).json({ error: "agent not found" });
    return;
  }

  // orch-pr-17: opt-in "correct-not-just-add" flag. Default OFF — when off, the
  // factual-column overwrite gating below is skipped entirely and the endpoint's
  // write behaviour is unchanged. Accepts ?allow_correct=1|true or body flag.
  const allowCorrect =
    body.allow_correct === true ||
    req.query?.allow_correct === "1" ||
    req.query?.allow_correct === "true";

  // ── Build the column-write piece ──────────────────────────────────────
  // Only touch columns the caller actually provided (matching the spirit
  // of the existing knowledge-service.upsertKnowledge merge — `undefined`
  // preserves, explicit value overwrites).
  const columnUpdates: { col: string; val: unknown }[] = [];
  if (typeof body.about === "string") columnUpdates.push({ col: "about", val: body.about });
  if (typeof body.address === "string") columnUpdates.push({ col: "address", val: body.address });
  if (typeof body.phone === "string") columnUpdates.push({ col: "phone", val: body.phone });
  if (typeof body.email === "string") columnUpdates.push({ col: "email", val: body.email });
  if (typeof body.postalCode === "string")
    columnUpdates.push({ col: "postal_code", val: body.postalCode });
  if (typeof body.website === "string") columnUpdates.push({ col: "website", val: body.website });
  if (body.products !== undefined)
    columnUpdates.push({ col: "products", val: JSON.stringify(body.products) });
  if (body.openingHours !== undefined)
    columnUpdates.push({ col: "opening_hours", val: JSON.stringify(body.openingHours) });

  // ── PR-A: CONTENT columns that live on the `agents` table ─────────────────
  // description (string) and categories (JSON array) are NOT agent_knowledge
  // columns, so they go through a separate write set applied to `agents` in the
  // SAME transaction. Additive: only provided keys are touched. categories is
  // normalized to a JSON-array string (accepts string[] or a pre-serialized
  // JSON string; a non-array primitive is wrapped defensively as []).
  const agentColumnUpdates: { col: string; val: unknown }[] = [];
  if (typeof body.description === "string")
    agentColumnUpdates.push({ col: "description", val: body.description });
  if (body.categories !== undefined) {
    let catVal: string;
    if (typeof body.categories === "string") {
      // Trust a pre-serialized JSON array string; otherwise wrap the raw string.
      const trimmed = body.categories.trim();
      catVal = trimmed.startsWith("[") ? trimmed : JSON.stringify([trimmed]);
    } else if (Array.isArray(body.categories)) {
      catVal = JSON.stringify(body.categories);
    } else {
      catVal = "[]";
    }
    agentColumnUpdates.push({ col: "categories", val: catVal });
  }

  // ── Build the field_provenance piece ──────────────────────────────────
  // PR-28: wrap merge in try/catch so an unexpected on-disk shape returns
  // a structured 500 JSON instead of letting the throw escape to express's
  // default HTML handler.
  let provenanceMerged: Record<string, ProvenanceRecord[]> | null = null;
  if (body.field_provenance && typeof body.field_provenance === "object") {
    const existingRow = db
      .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
      .get(agentId) as { field_provenance?: string } | undefined;
    let existing: Record<string, unknown> = {};
    if (existingRow?.field_provenance) {
      try {
        const parsed = JSON.parse(existingRow.field_provenance);
        if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    try {
      provenanceMerged = mergeFieldProvenance(existing, body.field_provenance);
    } catch (mergeErr: any) {
      res.status(500).json({
        error: "field_provenance_merge_failed",
        detail: mergeErr?.message ?? String(mergeErr),
      });
      return;
    }
  }

  // ── orch-pr-17: SAFE correct-not-just-add gating (opt-in) ─────────────────
  // When allow_correct is ON, each FACTUAL column being written (products /
  // address / phone / about) that would OVERWRITE a populated, differing legacy
  // value is gated through canCorrectFactualField(). Unsafe overwrites are
  // dropped from the write set (legacy value preserved) and reported. Pure ADDs
  // (no existing value) and non-factual columns are never gated, so additive
  // enrichment is unchanged. When allow_correct is OFF this block does nothing.
  const corrections: Array<{ field: string; action: "applied" | "refused" | "added" | "noop"; reason: string }> = [];
  if (allowCorrect && (columnUpdates.length > 0 || agentColumnUpdates.length > 0)) {
    // Parse existing row: current factual column values + field_provenance + curated_fields.
    const existingRow = db
      .prepare(
        "SELECT about, address, phone, products, field_provenance, curated_fields FROM agent_knowledge WHERE agent_id = ?",
      )
      .get(agentId) as
      | {
          about?: string | null;
          address?: string | null;
          phone?: string | null;
          products?: string | null;
          field_provenance?: string | null;
          curated_fields?: string | null;
        }
      | undefined;

    // Parse existing field_provenance (for per-field provenance + website_ownership).
    let existingProv: Record<string, unknown> = {};
    if (existingRow?.field_provenance) {
      try {
        const parsed = JSON.parse(existingRow.field_provenance);
        if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
      } catch {
        existingProv = {};
      }
    }
    const woUnverified =
      !!existingProv.website_ownership &&
      typeof existingProv.website_ownership === "object" &&
      (existingProv.website_ownership as Record<string, unknown>).status === "unverified";

    // Parse curated_fields (locked fields enrichment must never touch).
    let curated: Record<string, unknown> = {};
    if (existingRow?.curated_fields) {
      try {
        const parsed = JSON.parse(existingRow.curated_fields);
        if (parsed && typeof parsed === "object") curated = parsed as Record<string, unknown>;
      } catch {
        curated = {};
      }
    }

    // Normalise the INCOMING provenance on its own (existing={}) so we can judge
    // the NEW value's source tiers per field.
    let incomingProv: Record<string, ProvenanceRecord[]> = {};
    if (body.field_provenance && typeof body.field_provenance === "object") {
      try {
        incomingProv = mergeFieldProvenance({}, body.field_provenance);
      } catch {
        incomingProv = {};
      }
    }

    // PR-A: existing CONTENT values from the `agents` table (description/categories).
    const agentExistingRow = db
      .prepare("SELECT description, categories FROM agents WHERE id = ?")
      .get(agentId) as { description?: string | null; categories?: string | null } | undefined;

    // Map column-name → existing stored value (raw column string). Includes the
    // agents-table content columns so the same gating loop logic can run on them.
    const existingColVal: Record<string, string | null | undefined> = {
      about: existingRow?.about,
      address: existingRow?.address,
      phone: existingRow?.phone,
      products: existingRow?.products,
      description: agentExistingRow?.description,
      categories: agentExistingRow?.categories,
    };

    // Filter columnUpdates: drop unsafe factual overwrites.
    const keptUpdates: typeof columnUpdates = [];
    for (const u of columnUpdates) {
      if (!CORRECTABLE_FACTUAL_FIELDS.includes(u.col)) {
        keptUpdates.push(u); // non-factual column — never gated.
        continue;
      }
      const oldVal = existingColVal[u.col];
      const oldPopulated = typeof oldVal === "string" && oldVal.trim() !== "" && oldVal.trim() !== "[]";
      const newStr = u.val == null ? "" : String(u.val);
      if (!oldPopulated) {
        // Pure ADD (no real legacy value) — normal additive write, always allowed.
        keptUpdates.push(u);
        corrections.push({ field: u.col, action: "added", reason: "no_existing_value" });
        continue;
      }
      if (String(oldVal) === newStr) {
        // Unchanged — no overwrite happening.
        keptUpdates.push(u);
        corrections.push({ field: u.col, action: "noop", reason: "unchanged" });
        continue;
      }
      // Real overwrite of a populated, differing legacy value → gate it.
      const decision = canCorrectFactualField({
        field: u.col,
        existingFieldProvenance: existingProv[u.col],
        websiteOwnershipUnverified: woUnverified,
        incomingFieldProvenance: incomingProv[u.col],
        isCurated: !!curated[u.col],
      });
      if (decision.allowed) {
        keptUpdates.push(u);
        corrections.push({ field: u.col, action: "applied", reason: decision.reason });
      } else {
        // Refused — drop this column from the write set; legacy value preserved.
        corrections.push({ field: u.col, action: "refused", reason: decision.reason });
      }
    }
    // Replace the write set with the gated one.
    columnUpdates.length = 0;
    columnUpdates.push(...keptUpdates);

    // PR-A: gate the agents-table CONTENT columns (description/categories) with
    // the SAME logic. canCorrectFactualField treats them as CONTENT fields, so a
    // single website_homepage source overwrites google_places content, while
    // curated_locked refuses absolutely. Pure ADDs and unchanged values pass.
    const keptAgentUpdates: typeof agentColumnUpdates = [];
    for (const u of agentColumnUpdates) {
      const oldVal = existingColVal[u.col];
      const oldPopulated = typeof oldVal === "string" && oldVal.trim() !== "" && oldVal.trim() !== "[]";
      const newStr = u.val == null ? "" : String(u.val);
      if (!oldPopulated) {
        keptAgentUpdates.push(u);
        corrections.push({ field: u.col, action: "added", reason: "no_existing_value" });
        continue;
      }
      if (String(oldVal) === newStr) {
        keptAgentUpdates.push(u);
        corrections.push({ field: u.col, action: "noop", reason: "unchanged" });
        continue;
      }
      const decision = canCorrectFactualField({
        field: u.col,
        existingFieldProvenance: existingProv[u.col],
        websiteOwnershipUnverified: woUnverified,
        incomingFieldProvenance: incomingProv[u.col],
        isCurated: !!curated[u.col],
      });
      if (decision.allowed) {
        keptAgentUpdates.push(u);
        corrections.push({ field: u.col, action: "applied", reason: decision.reason });
      } else {
        corrections.push({ field: u.col, action: "refused", reason: decision.reason });
      }
    }
    agentColumnUpdates.length = 0;
    agentColumnUpdates.push(...keptAgentUpdates);
  }

  // ── Apply ─────────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    // Ensure a row exists. The agent_knowledge row may not be present
    // for newly-registered agents that haven't been enriched before.
    const existsRow = db
      .prepare("SELECT 1 AS one FROM agent_knowledge WHERE agent_id = ?")
      .get(agentId) as { one: number } | undefined;
    if (!existsRow) {
      db.prepare(
        "INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)",
      ).run(agentId, now);
    }

    if (columnUpdates.length > 0) {
      const setClause = columnUpdates.map((u) => `${u.col} = ?`).join(", ");
      const params = columnUpdates.map((u) => u.val);
      params.push(now);
      params.push(agentId);
      db.prepare(
        `UPDATE agent_knowledge SET ${setClause}, updated_at = ? WHERE agent_id = ?`,
      ).run(...params);
    }

    // PR-A: write CONTENT columns that live on the `agents` table in the SAME
    // transaction (description/categories). The agents table has no updated_at
    // column, so we only set the provided columns. Column names are from a fixed
    // allow-list (description/categories), never user input, so the dynamic SET
    // clause is injection-safe.
    if (agentColumnUpdates.length > 0) {
      const aSet = agentColumnUpdates.map((u) => `${u.col} = ?`).join(", ");
      const aParams = agentColumnUpdates.map((u) => u.val);
      aParams.push(agentId);
      db.prepare(`UPDATE agents SET ${aSet} WHERE id = ?`).run(...aParams);
    }

    if (provenanceMerged !== null) {
      db.prepare(
        "UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?",
      ).run(JSON.stringify(provenanceMerged), now, agentId);
    }
  });

  try {
    tx();
  } catch (err: any) {
    res.status(500).json({ error: "write_failed", detail: err?.message ?? String(err) });
    return;
  }

  // Echo back what we ended up with — useful for the SKILL to log
  // counts per field for the daily enrichment-report.
  const summary: Record<string, number> = {};
  if (provenanceMerged) {
    for (const [field, arr] of Object.entries(provenanceMerged)) {
      summary[field] = arr.length;
    }
  }

  res.json({
    success: true,
    agent_id: agentId,
    // PR-A: include agents-table content columns (description/categories) in the
    // echoed set alongside the agent_knowledge columns.
    columns_updated: [...columnUpdates.map((u) => u.col), ...agentColumnUpdates.map((u) => u.col)],
    field_provenance_counts: summary,
    // orch-pr-17: present only when allow_correct was on — per-field outcome of
    // the correct-not-just-add guard (applied / refused / added / noop).
    ...(allowCorrect ? { allow_correct: true, corrections } : {}),
  });
});


export default router;

// ─── POST /admin/prune-dead-urls (orch-pr-9, 2026-06-14) ─────────────────────
//
// Scans agent_knowledge.website for junk/dead values and optionally nulls them.
// Two categories are pruned:
//   1. placeholder/non-URL — does not parse as a valid URL with a host, or
//      matches placeholder patterns (case-insensitive).
//   2. aggregator/directory host — the registrable host is in
//      KNOWN_DIRECTORY_HOSTS via isKnownDirectoryHost().
//
// Everything else is left alone (a real-looking domain is kept even if its
// last probe failed — "blank is worse than stale" per enrichment policy).
//
// Params:
//   ?apply=1  or  body { apply: true }  — write to DB; default = dry-run.
//   ?limit=N                            — cap rows scanned (omit = whole table).
//   ?offset=N                           — DRY-RUN ONLY: skip N rows (deterministic
//                                         ORDER BY agent_id) to inspect the whole
//                                         table past the first batch (orch-pr-27).
//                                         REJECTED (400) together with apply: on
//                                         apply, NULLed rows leave the candidate
//                                         set, so offset would skip survivors. To
//                                         apply across the whole table, loop
//                                         ?apply=1&limit=500 until pruned=0.
//
// Returns:
//   { success, dry_run, scanned, would_prune: { placeholder, aggregator, total },
//     sample: [{agent_id, website, reason}], pruned: <n when apply> }

// Placeholder strings that are never real URLs.
const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /^not available$/i,
  /^n\/a$/i,
  /^none$/i,
  /^tbd$/i,
  /^ukjent$/i,
  /^ingen$/i,
  /^-+$/,
];

// Return the full lowercased host (www stripped, e.g. "lokalmat.coop.no") for a
// parsed URL, or null if it cannot be determined. orch-pr-27: we now classify
// against the FULL host (not just the eTLD+1) so multi-label aggregator hosts
// like lokalmat.coop.no / oslo.kommune.no are caught by
// isDirectoryOrAggregatorHost (which suffix-walks + matches host families).
function parsedHostForUrl(raw: string): string | null {
  let parsed: URL;
  try {
    // Ensure scheme is present so URL() can parse it.
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  return host;
}

type PruneReason = "placeholder" | "aggregator";

interface PruneSample {
  agent_id: string;
  website: string;
  reason: PruneReason;
}

function classifyWebsite(website: string): PruneReason | null {
  const trimmed = website.trim();
  if (!trimmed) return "placeholder"; // empty → placeholder

  // Check placeholder patterns
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (pat.test(trimmed)) return "placeholder";
  }

  // Parse as a URL and get the FULL host (e.g. "lokalmat.coop.no").
  const host = parsedHostForUrl(trimmed);
  if (!host) {
    // Cannot be parsed as a URL with a host → treat as placeholder
    return "placeholder";
  }

  // Directory / aggregator / municipal / placeholder host (broadened matcher).
  if (isDirectoryOrAggregatorHost(host)) return "aggregator";

  // Real-looking domain — keep it
  return null;
}

export const pruneUrlsRouter = Router();

pruneUrlsRouter.post("/prune-dead-urls", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();

  // Determine apply mode from query string or body
  const applyFromQuery = req.query["apply"] === "1" || req.query["apply"] === "true";
  const bodyApply = (req.body as Record<string, unknown> | undefined)?.apply;
  const applyFromBody =
    typeof bodyApply === "boolean"
      ? bodyApply
      : bodyApply === "1" || bodyApply === "true";
  const apply = applyFromQuery || applyFromBody;
  const dryRun = !apply;

  // orch-pr-27: offset is a DRY-RUN inspection aid only. On apply, pruned rows
  // drop out of the WHERE filter, so a non-zero offset would skip surviving
  // candidates (silent under-prune). Reject the combination explicitly; callers
  // page an apply by looping ?apply=1&limit=N until pruned=0.
  const offsetRaw = req.query["offset"];
  const offsetRequested =
    offsetRaw !== undefined && !isNaN(Number(offsetRaw)) && Number(offsetRaw) > 0;
  if (apply && offsetRequested) {
    res.status(400).json({
      success: false,
      error: "offset is not allowed with apply=1; loop ?apply=1&limit=N until pruned=0",
    });
    return;
  }

  // Optional row limit
  const limitParam = req.query["limit"];
  const limit =
    limitParam !== undefined && !isNaN(Number(limitParam)) && Number(limitParam) > 0
      ? Number(limitParam)
      : null;

  // Deterministic paging offset (validated above; 0 unless a positive dry-run offset).
  const offset = offsetRequested ? Math.floor(Number(offsetRaw)) : 0;

  // Fetch non-empty websites, deterministically ordered so limit/offset paging
  // is stable across calls. SQLite needs a LIMIT before OFFSET, so when no limit
  // is given but an offset is, we pass LIMIT -1 (= unbounded) OFFSET N.
  const base =
    "SELECT ak.agent_id, ak.website FROM agent_knowledge ak " +
    "WHERE ak.website IS NOT NULL AND trim(ak.website) != '' ORDER BY ak.agent_id";
  let rows: { agent_id: string; website: string }[];
  if (limit !== null) {
    rows = db.prepare(base + " LIMIT ? OFFSET ?").all(limit, offset) as {
      agent_id: string;
      website: string;
    }[];
  } else if (offset > 0) {
    rows = db.prepare(base + " LIMIT -1 OFFSET ?").all(offset) as {
      agent_id: string;
      website: string;
    }[];
  } else {
    rows = db.prepare(base).all() as { agent_id: string; website: string }[];
  }

  const scanned = rows.length;
  let placeholder = 0;
  let aggregator = 0;
  const sample: PruneSample[] = [];
  const toPrune: { agent_id: string; reason: PruneReason }[] = [];

  for (const row of rows) {
    const reason = classifyWebsite(row.website);
    if (reason === null) continue; // keep

    if (reason === "placeholder") placeholder++;
    else aggregator++;

    toPrune.push({ agent_id: row.agent_id, reason });
    if (sample.length < 20) {
      sample.push({ agent_id: row.agent_id, website: row.website, reason });
    }
  }

  const total = placeholder + aggregator;

  if (dryRun) {
    res.json({
      success: true,
      dry_run: true,
      scanned,
      limit,
      offset,
      would_prune: { placeholder, aggregator, total },
      sample,
    });
    return;
  }

  // Apply: null the website for each matched agent (parameterized, idempotent).
  // The WHERE website IS NOT NULL guard makes re-runs report pruned=0.
  let pruned = 0;
  if (toPrune.length > 0) {
    const updateStmt = db.prepare(
      "UPDATE agent_knowledge SET website = NULL, updated_at = datetime('now') WHERE agent_id = ? AND website IS NOT NULL"
    );
    const tx = db.transaction(() => {
      for (const item of toPrune) {
        const info = updateStmt.run(item.agent_id);
        pruned += info.changes;
      }
    });
    tx();
  }

  console.log(
    `[prune-dead-urls] scanned=${scanned} pruned=${pruned} (placeholder=${placeholder} aggregator=${aggregator})`
  );

  res.json({
    success: true,
    dry_run: false,
    scanned,
    limit,
    offset,
    would_prune: { placeholder, aggregator, total },
    sample,
    pruned,
  });
});

// ─── POST /admin/homepage-content-refresh (PR-24a, 2026-06-16) ───────────────
//
// WHY: producer profiles show WRONG content (business type / products) because
// about/products/categories were taken from google_places, not the producer's
// own homepage — which triggers profile-removal requests (Grette shown as meat
// not vegetables, Fløy listing lefser it doesn't make, Bomstad shown as fish not
// goat). PR-22 (live) added the homepage CONTENT extractors (extractVisibleText
// / extractBusinessTypeTokens / extractProductMentions / summarizeAbout) and
// made the write-path PREFER homepage (canCorrectFactualField lets a single
// website_homepage source overwrite google_places content) — but nothing wired
// them to actually WRITE content. This endpoint is that writer.
//
// WHAT: for targeted/auto-selected producers, fetch their OWN homepage
// server-side (same bypass-the-sandbox approach as /admin/homepage-provenance-
// batch), run the PR-22 extractors, build candidate about/description/products/
// categories, and write each ONLY through canCorrectFactualField() — so curated/
// locked fields are never touched and website_homepage overwrites google_places.
// On each allowed field we update the column AND merge field_provenance with a
// {source_type:"website_homepage", source_url, fetched_at, value} record via
// mergeFieldProvenance. Dry-run by default; apply=1 to write.
//
// SAFETY: NEVER touches contact fields (email/phone/address). NEVER deletes a
// producer. Excludes umbrella-tagged agents. Reuses the SSRF guard + the gate.
//
// Auth: same x-admin-key pattern as /admin/homepage-provenance-batch.

export const homepageContentRefreshRouter = Router();

// Norwegian display label per platform category (for the products[].name field;
// products is stored as ProductInfo[] = [{name, category, seasonal}]). Aligned
// with routes/seo.ts CATEGORY_LABELS_NO.
const CATEGORY_LABEL_NO: Readonly<Record<string, string>> = {
  meat: "Kjøtt",
  dairy: "Meieri",
  vegetables: "Grønnsaker",
  fruit: "Frukt",
  bakery: "Bakervarer",
  beverages: "Drikke",
  honey: "Honning",
  eggs: "Egg",
  fish: "Fisk",
  preserves: "Syltetøy",
  herbs: "Urter",
  other: "Annet",
};

const HCR_FETCH_TIMEOUT_MS = 10_000;
const HCR_UA = "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)";
// Same-host sub-pages worth crawling for content (mirrors the search-enrich
// crawl's /om-oss, plus /about and /produkter per spec).
const HCR_CONTENT_PATHS: readonly string[] = ["/om-oss", "/about", "/produkter"];

/** Fetch one URL's HTML server-side (SSRF-guarded). Returns null on any failure. */
async function hcrFetchHtml(url: string): Promise<string | null> {
  if (!isSafeFetchUrl(url)) return null;
  const fetchUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const resp = await fetch(fetchUrl, {
      redirect: "follow",
      headers: { "User-Agent": HCR_UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(HCR_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Fetch a producer's homepage + same-host content sub-pages, concatenated. The
 * primary page's HTML is returned first (so summarizeAbout's og/meta lookups hit
 * the homepage), with sub-page HTML appended for the token/product scans. Returns
 * null only if the primary homepage cannot be fetched.
 */
async function hcrFetchHomepageContent(
  homepageUrl: string,
): Promise<{ primaryHtml: string; combinedHtml: string; fetchUrl: string } | null> {
  const fetchUrl = /^https?:\/\//i.test(homepageUrl) ? homepageUrl : `https://${homepageUrl}`;
  const primaryHtml = await hcrFetchHtml(fetchUrl);
  if (primaryHtml === null) return null;
  let combinedHtml = primaryHtml;
  try {
    const u = new URL(fetchUrl);
    const base = `${u.protocol}//${u.host}`;
    for (const path of HCR_CONTENT_PATHS) {
      const sub = await hcrFetchHtml(`${base}${path}`);
      if (sub) combinedHtml += "\n" + sub;
    }
  } catch {
    /* malformed URL — primary homepage content still stands */
  }
  return { primaryHtml, combinedHtml, fetchUrl };
}

type HcrTargetRow = {
  agent_id: string;
  name: string | null;
  homepage_url: string | null;
};

type HcrFieldWrite = { field: string; value: string; columnVal: unknown; onAgents: boolean };

homepageContentRefreshRouter.post(
  "/homepage-content-refresh",
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const body = (req.body ?? {}) as {
      agentIds?: unknown;
      limit?: unknown;
      apply?: unknown;
    };

    // apply: dry-run by default. apply=1 / "1" / true (body) or ?apply=1.
    const apply =
      body.apply === true ||
      body.apply === 1 ||
      body.apply === "1" ||
      body.apply === "true" ||
      req.query?.apply === "1" ||
      req.query?.apply === "true";
    const dryRun = !apply;

    // limit: default 25, hard cap 100.
    const limit = Math.min(
      typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : 25,
      100,
    );

    const db = getDb();

    // ── Target selection ─────────────────────────────────────────────────────
    let targets: HcrTargetRow[];
    if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
      // Explicit list — trust the caller, cap by limit, still exclude umbrellas
      // and require a usable homepage (website || agents.url).
      const ids = (body.agentIds as unknown[])
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim())
        .slice(0, limit);
      targets = ids
        .map((id) => {
          const row = db
            .prepare(
              `SELECT a.id AS agent_id, a.name AS name, a.umbrella_type AS umbrella_type,
                      COALESCE(NULLIF(TRIM(k.website), ''), NULLIF(TRIM(a.url), '')) AS homepage_url
                 FROM agents a
                 LEFT JOIN agent_knowledge k ON k.agent_id = a.id
                WHERE a.id = ?`,
            )
            .get(id) as
            | { agent_id: string; name: string | null; umbrella_type: string | null; homepage_url: string | null }
            | undefined;
          return row;
        })
        .filter(
          (r): r is { agent_id: string; name: string | null; umbrella_type: string | null; homepage_url: string | null } =>
            !!r && r.umbrella_type == null && !!r.homepage_url && r.homepage_url.trim().length > 0,
        )
        .map((r) => ({ agent_id: r.agent_id, name: r.name, homepage_url: r.homepage_url }));
    } else {
      // Auto-select: producers (non-umbrella) WITH a website AND existing
      // about/products, whose CONTENT provenance does NOT yet carry a
      // website_homepage source for about/products/description/categories — i.e.
      // their content is still google-sourced (the potentially-wrong ones).
      const rows = db
        .prepare(
          `SELECT a.id AS agent_id, a.name AS name,
                  COALESCE(NULLIF(TRIM(k.website), ''), NULLIF(TRIM(a.url), '')) AS homepage_url
             FROM agents a
             JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.umbrella_type IS NULL
              AND (
                    (k.website IS NOT NULL AND TRIM(k.website) != '')
                 OR (a.url IS NOT NULL AND TRIM(a.url) != '')
                  )
              AND (
                    (k.about IS NOT NULL AND TRIM(k.about) != '')
                 OR (k.products IS NOT NULL AND TRIM(k.products) != '' AND TRIM(k.products) != '[]')
                  )
              AND (
                    k.field_provenance IS NULL
                 OR k.field_provenance = '{}'
                 OR k.field_provenance NOT LIKE '%"website_homepage"%'
                  )
            ORDER BY k.updated_at ASC
            LIMIT ?`,
        )
        .all(limit) as HcrTargetRow[];
      targets = rows.filter((r) => r.homepage_url && r.homepage_url.trim().length > 0);
    }

    // ── Per-agent processing ──────────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    let scanned = 0;
    const byField: Record<string, number> = { about: 0, products: 0, categories: 0, description: 0 };
    const changed: Array<{ agent_id: string; fields: string[] }> = [];
    const skippedCurated: Array<{ agent_id: string; fields: string[] }> = [];
    const errors: Array<{ agent_id: string; error: string }> = [];

    // Bounded concurrency for the network fetches (mirrors homepage-provenance-batch).
    const HCR_CONCURRENCY = 3;

    async function processOne(t: HcrTargetRow): Promise<void> {
      const agentId = t.agent_id;
      if (!t.homepage_url) {
        errors.push({ agent_id: agentId, error: "no_homepage_url" });
        return;
      }

      // Fetch homepage content server-side.
      let fetched: { primaryHtml: string; combinedHtml: string; fetchUrl: string } | null;
      try {
        fetched = await hcrFetchHomepageContent(t.homepage_url);
      } catch (e: any) {
        errors.push({ agent_id: agentId, error: e?.message ?? String(e) });
        return;
      }
      if (!fetched) {
        errors.push({ agent_id: agentId, error: `fetch_failed for ${t.homepage_url}` });
        return;
      }
      const { primaryHtml, combinedHtml, fetchUrl } = fetched;

      // Run the PR-22 extractors on the fetched HTML.
      const contentText = extractVisibleText(combinedHtml);
      const businessTokens = extractBusinessTypeTokens(contentText);
      const productCats = extractProductMentions(contentText);
      const platformCategories = mapToPlatformCategories(productCats, businessTokens);
      const aboutSummary = summarizeAbout(primaryHtml);

      // Build candidate content fields.
      const candidates: HcrFieldWrite[] = [];

      // about / description from summarizeAbout — only if it clears the quality bar.
      if (meetsAboutQualityBar(aboutSummary)) {
        candidates.push({ field: "about", value: aboutSummary, columnVal: aboutSummary, onAgents: false });
        candidates.push({ field: "description", value: aboutSummary, columnVal: aboutSummary, onAgents: true });
      }

      // products from the detected platform categories → ProductInfo[] shape.
      if (platformCategories.length > 0) {
        const productObjs = platformCategories.map((cat) => ({
          name: CATEGORY_LABEL_NO[cat] ?? cat,
          category: cat,
          seasonal: false,
        }));
        candidates.push({
          field: "products",
          // Stable provenance value: canonical category list (order-independent).
          value: platformCategories.join(","),
          columnVal: JSON.stringify(productObjs),
          onAgents: false,
        });
        // categories (agents table) — JSON array of platform category keys.
        candidates.push({
          field: "categories",
          value: platformCategories.join(","),
          columnVal: JSON.stringify(platformCategories),
          onAgents: true,
        });
      }

      scanned++;
      if (candidates.length === 0) return; // nothing extractable — leave as-is.

      // Load existing provenance + curated locks + current column values.
      const kRow = db
        .prepare(
          "SELECT about, products, field_provenance, curated_fields FROM agent_knowledge WHERE agent_id = ?",
        )
        .get(agentId) as
        | {
            about?: string | null;
            products?: string | null;
            field_provenance?: string | null;
            curated_fields?: string | null;
          }
        | undefined;
      let existingProv: Record<string, unknown> = {};
      if (kRow?.field_provenance) {
        try {
          const parsed = JSON.parse(kRow.field_provenance);
          if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
        } catch {
          /* tolerate junk */
        }
      }
      const woUnverified =
        !!existingProv.website_ownership &&
        typeof existingProv.website_ownership === "object" &&
        (existingProv.website_ownership as Record<string, unknown>).status === "unverified";

      let curated: Record<string, unknown> = {};
      if (kRow?.curated_fields) {
        try {
          const parsed = JSON.parse(kRow.curated_fields);
          if (parsed && typeof parsed === "object") curated = parsed as Record<string, unknown>;
        } catch {
          /* tolerate junk */
        }
      }

      // Decide each field through the gate. Build the write set + provenance.
      const fieldsToWrite: HcrFieldWrite[] = [];
      const incomingProvForMerge: Record<
        string,
        { sources: Array<{ source_type: string; value: string; fetched_at: string; source_url: string }> }
      > = {};
      const curatedSkipped: string[] = [];

      for (const cand of candidates) {
        // Incoming provenance for THIS field carries a single website_homepage
        // source — that is what makes canCorrectFactualField allow overwriting a
        // google_places value (and a pure-add when the field is empty).
        const incomingFieldProv = [
          { source_type: "website_homepage", value: cand.value, fetched_at: nowIso, source_url: fetchUrl },
        ];
        const decision = canCorrectFactualField({
          field: cand.field,
          existingFieldProvenance: existingProv[cand.field],
          websiteOwnershipUnverified: woUnverified,
          incomingFieldProvenance: incomingFieldProv,
          isCurated: !!curated[cand.field],
        });
        if (decision.allowed) {
          fieldsToWrite.push(cand);
          incomingProvForMerge[cand.field] = { sources: incomingFieldProv };
        } else if (decision.reason === "curated_locked") {
          curatedSkipped.push(cand.field);
        }
        // Other refusals (e.g. existing already homepage-sourced) are silently
        // skipped — we never overwrite a non-google_places content value.
      }

      if (curatedSkipped.length > 0) {
        skippedCurated.push({ agent_id: agentId, fields: Array.from(new Set(curatedSkipped)) });
      }
      if (fieldsToWrite.length === 0) return;

      const writtenFields = Array.from(new Set(fieldsToWrite.map((f) => f.field)));
      for (const f of writtenFields) {
        if (f in byField) byField[f] = (byField[f] ?? 0) + 1;
      }
      changed.push({ agent_id: agentId, fields: writtenFields });

      if (dryRun) return; // dry-run: report only, write nothing.

      // ── Apply: column writes + provenance merge in one transaction ───────────
      let mergedProv: Record<string, unknown>;
      try {
        mergedProv = mergeFieldProvenance(existingProv, incomingProvForMerge);
      } catch (mergeErr: any) {
        errors.push({ agent_id: agentId, error: `provenance_merge_failed: ${mergeErr?.message ?? String(mergeErr)}` });
        return;
      }
      const provJson = JSON.stringify(mergedProv);

      const akUpdates = fieldsToWrite.filter((f) => !f.onAgents); // about / products
      const agentUpdates = fieldsToWrite.filter((f) => f.onAgents); // description / categories

      try {
        const tx = db.transaction(() => {
          // Ensure an agent_knowledge row exists (auto-created agents may lack one).
          const exists = db
            .prepare("SELECT 1 AS one FROM agent_knowledge WHERE agent_id = ?")
            .get(agentId) as { one: number } | undefined;
          if (!exists) {
            db.prepare(
              "INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)",
            ).run(agentId, nowIso);
          }

          // agent_knowledge content columns (about/products) — never contact fields.
          if (akUpdates.length > 0) {
            const setClause = akUpdates.map((u) => `${u.field} = ?`).join(", ");
            const params: unknown[] = akUpdates.map((u) => u.columnVal);
            params.push(provJson, nowIso, agentId);
            db.prepare(
              `UPDATE agent_knowledge SET ${setClause}, field_provenance = ?, updated_at = ? WHERE agent_id = ?`,
            ).run(...params);
          } else {
            // Only agents-table fields changed — still persist provenance.
            db.prepare(
              "UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?",
            ).run(provJson, nowIso, agentId);
          }

          // agents-table content columns (description/categories). Column names
          // come from a fixed allow-list (description/categories), never user
          // input, so the dynamic SET is injection-safe. No updated_at on agents.
          if (agentUpdates.length > 0) {
            const aSet = agentUpdates.map((u) => `${u.field} = ?`).join(", ");
            const aParams: unknown[] = agentUpdates.map((u) => u.columnVal);
            aParams.push(agentId);
            db.prepare(`UPDATE agents SET ${aSet} WHERE id = ?`).run(...aParams);
          }
        });
        tx();
      } catch (writeErr: any) {
        errors.push({ agent_id: agentId, error: `write_failed: ${writeErr?.message ?? String(writeErr)}` });
        // Roll the reporting back for this agent — the tx aborted atomically.
        const idx = changed.findIndex((c) => c.agent_id === agentId);
        if (idx >= 0) {
          for (const f of changed[idx].fields) {
            if (f in byField && byField[f] > 0) byField[f] -= 1;
          }
          changed.splice(idx, 1);
        }
      }
    }

    for (let i = 0; i < targets.length; i += HCR_CONCURRENCY) {
      const slice = targets.slice(i, i + HCR_CONCURRENCY);
      await Promise.all(slice.map((t) => processOne(t)));
    }

    res.json({
      dry_run: dryRun,
      scanned,
      by_field: byField,
      changed,
      skipped_curated: skippedCurated,
      errors,
    });
  },
);

// ─── GET/POST /admin/description-truncation-sweep (dev-request ──────────────
//     2026-07-01-cs-corrections-profile-quality, item C) ────────────────────
//
// WHY: a historical bug cut `agents.description` text at a raw BYTE offset
// instead of a JS-string-safe offset, so a multi-byte UTF-8 character
// (æ/ø/å) could get chopped in half, landing a Unicode replacement character
// (U+FFFD, "�") in the stored description — reported live on Olestølen
// Mikroysteri's profile ("...opplevelser p�"). Two nets already exist for
// NEW writes: a render-time guard (safeMetaDescription() in routes/seo.ts,
// now exported for reuse) and a write-time gate — but rows corrupted BEFORE
// those nets existed are still sitting in the DB. This is the one-time
// backfill/cleanup surface for those already-corrupted rows.
//
// NON-GOALS (do not extend this endpoint to cover these): no re-crawl/
// re-enrichment of content; agent_knowledge.about is a DIFFERENT column on a
// DIFFERENT table and is NOT implicated in this byte-slice bug — this sweep
// touches ONLY agents.description.
//
// GET  /admin/description-truncation-sweep
//   Read-only diagnostic — ZERO writes. Scans every agents.description for a
//   "�", and returns a capped report (id, name, snippet around the
//   corruption). Capped the same way GET /admin/experiences-dedup-audit caps
//   its response (AUDIT_RESPONSE_GROUP_CAP in routes/opplevelser.ts) so a
//   large corpus can't blow up the response.
//
// POST /admin/description-truncation-sweep
//   Body: { dry_run?: boolean } — dry_run DEFAULTS TO TRUE when absent/not
//   exactly `false` (STRICT-FALSE parse, mirroring POST
//   /admin/experiences-dedup-unmerge's convention exactly: null / "false" /
//   0 / "" / undefined all mean dry-run; only the JSON boolean `false` is a
//   real run). Dry-run reports the same diagnostic plus a preview of the
//   cleaned value. A real run re-selects the current description for each
//   candidate row RIGHT BEFORE writing and ONLY updates it if the "�" is
//   STILL present at that moment — a row fixed by anything else between the
//   scan and the write is left alone (never clobbers a since-fixed value),
//   and an already-clean row is never touched or overwritten.

const REPLACEMENT_CHAR = "�";
const TRUNCATION_SWEEP_RESPONSE_CAP = 100;
const TRUNCATION_SNIPPET_CONTEXT = 30;

interface CorruptedDescriptionRow {
  id: string;
  name: string;
  description: string;
}

/** Fetch every agents row whose description still carries the corruption marker. */
function findCorruptedDescriptions(db: ReturnType<typeof getDb>): CorruptedDescriptionRow[] {
  return db
    .prepare("SELECT id, name, description FROM agents WHERE description LIKE ?")
    .all(`%${REPLACEMENT_CHAR}%`) as CorruptedDescriptionRow[];
}

/**
 * A short window of text around the FIRST "�" in a description, for a
 * human reviewing the diagnostic report. Pure — exported for unit-testing.
 */
export function truncationSnippet(description: string): string {
  const idx = description.indexOf(REPLACEMENT_CHAR);
  if (idx === -1) return description.slice(0, TRUNCATION_SNIPPET_CONTEXT * 2);
  const start = Math.max(0, idx - TRUNCATION_SNIPPET_CONTEXT);
  const end = Math.min(description.length, idx + TRUNCATION_SNIPPET_CONTEXT);
  return `${start > 0 ? "…" : ""}${description.slice(start, end)}${end < description.length ? "…" : ""}`;
}

export const descriptionTruncationSweepRouter = Router();

descriptionTruncationSweepRouter.get(
  "/description-truncation-sweep",
  (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const db = getDb();
    const corrupted = findCorruptedDescriptions(db);
    const report = corrupted.map((row) => ({
      id: row.id,
      name: row.name,
      snippet: truncationSnippet(row.description),
    }));

    res.json({
      success: true,
      dry_run: true,
      corrupted_count: report.length,
      rows_returned: Math.min(report.length, TRUNCATION_SWEEP_RESPONSE_CAP),
      rows_truncated: report.length > TRUNCATION_SWEEP_RESPONSE_CAP,
      rows: report.slice(0, TRUNCATION_SWEEP_RESPONSE_CAP),
    });
  },
);

descriptionTruncationSweepRouter.post(
  "/description-truncation-sweep",
  (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    // STRICT-FALSE parse (mirrors POST /admin/experiences-dedup-unmerge):
    // writes execute ONLY on the JSON boolean false. Anything else — null,
    // "false", 0, "", undefined — means dry-run, so a caller who leaves
    // dry_run unset gets the documented dry-run default, never a live sweep.
    const body = (req.body ?? {}) as { dry_run?: unknown };
    const dryRun = body.dry_run !== false;

    const db = getDb();
    const candidates = findCorruptedDescriptions(db);

    if (dryRun) {
      const preview = candidates.slice(0, TRUNCATION_SWEEP_RESPONSE_CAP).map((row) => ({
        id: row.id,
        name: row.name,
        before_snippet: truncationSnippet(row.description),
        after: safeMetaDescription(row.description),
      }));
      res.json({
        success: true,
        dry_run: true,
        would_update_count: candidates.length,
        rows_truncated: candidates.length > TRUNCATION_SWEEP_RESPONSE_CAP,
        would_update: preview,
      });
      return;
    }

    // Apply: re-check each row for the corruption marker RIGHT BEFORE writing
    // (never clobber a value that was already fixed since the scan above),
    // and only write rows that still need it.
    const getCurrent = db.prepare("SELECT description FROM agents WHERE id = ?");
    const updateDescription = db.prepare("UPDATE agents SET description = ? WHERE id = ?");

    const updatedIds: string[] = [];
    const unrepairableIds: string[] = [];
    const tx = db.transaction(() => {
      for (const candidate of candidates) {
        const current = getCurrent.get(candidate.id) as { description: string } | undefined;
        if (!current || !current.description.includes(REPLACEMENT_CHAR)) continue; // since-fixed or gone — leave alone
        const cleaned = safeMetaDescription(current.description);
        // A description that is corruption markers start-to-finish (or
        // whitespace-only after stripping them) cleans to "" — writing that
        // would trade a garbled-but-nonempty description for a blank one on
        // a live producer page. Skip and leave it flagged for manual
        // re-enrichment instead of blanking it.
        if (!cleaned || cleaned.includes(REPLACEMENT_CHAR)) {
          unrepairableIds.push(candidate.id);
          continue;
        }
        updateDescription.run(cleaned, candidate.id);
        updatedIds.push(candidate.id);
      }
    });
    tx();

    res.json({
      success: true,
      dry_run: false,
      scanned: candidates.length,
      updated_count: updatedIds.length,
      updated_ids: updatedIds.slice(0, TRUNCATION_SWEEP_RESPONSE_CAP),
      ids_truncated: updatedIds.length > TRUNCATION_SWEEP_RESPONSE_CAP,
      unrepairable_count: unrepairableIds.length,
      unrepairable_ids: unrepairableIds.slice(0, TRUNCATION_SWEEP_RESPONSE_CAP),
    });
  },
);
