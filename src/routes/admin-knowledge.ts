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
import { isKnownDirectoryHost } from "../services/cross-source-validator";

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
const CORRECT_TIER_A: ReadonlySet<string> = new Set(["homepage", "google_places"]);
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
} {
  const tierA = new Set<string>();
  let hasTierS = false;
  let realSourceCount = 0;
  let total = 0;
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
    }
  }
  return { tierADistinct: tierA.size, hasTierS, realSourceCount, total };
}

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

  if (!CORRECTABLE_FACTUAL_FIELDS.includes(field)) {
    return { allowed: false, reason: "field_not_correctable" };
  }

  // ── Hard refusals (checked first; any one blocks the overwrite) ────────────
  // 1. Owner-curated / locked field — never touch.
  if (isCurated) return { allowed: false, reason: "curated_locked" };

  const existing = summariseProvenance(existingFieldProvenance);
  const incoming = summariseProvenance(incomingFieldProvenance);

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
  if (allowCorrect && columnUpdates.length > 0) {
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

    // Map column-name → existing stored value (raw column string).
    const existingColVal: Record<string, string | null | undefined> = {
      about: existingRow?.about,
      address: existingRow?.address,
      phone: existingRow?.phone,
      products: existingRow?.products,
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
    columns_updated: columnUpdates.map((u) => u.col),
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
//   ?limit=N                            — cap rows scanned.
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

// Return the registrable domain (last two labels, with www stripped) for a
// parsed URL host, or null if it cannot be determined.
function registrableHostForUrl(raw: string): string | null {
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
  // Simple eTLD+1: last two labels (sufficient for .no, .com, .net, etc.)
  return labels.slice(-2).join(".");
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

  // Try to parse as a URL and get registrable host
  const host = registrableHostForUrl(trimmed);
  if (!host) {
    // Cannot be parsed as a URL with a host → treat as placeholder
    return "placeholder";
  }

  // Check directory/aggregator host
  if (isKnownDirectoryHost(host)) return "aggregator";

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

  // Optional row limit
  const limitParam = req.query["limit"];
  const limit =
    limitParam !== undefined && !isNaN(Number(limitParam)) && Number(limitParam) > 0
      ? Number(limitParam)
      : null;

  // Fetch all non-empty websites
  const query = limit !== null
    ? "SELECT ak.agent_id, ak.website FROM agent_knowledge ak WHERE ak.website IS NOT NULL AND trim(ak.website) != '' LIMIT ?"
    : "SELECT ak.agent_id, ak.website FROM agent_knowledge ak WHERE ak.website IS NOT NULL AND trim(ak.website) != ''";

  const rows = (limit !== null
    ? db.prepare(query).all(limit)
    : db.prepare(query).all()
  ) as { agent_id: string; website: string }[];

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
    would_prune: { placeholder, aggregator, total },
    sample,
    pruned,
  });
});
