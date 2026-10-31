// ─── Admin: POST /admin/agents/content-correction ──────────────────────────
//
// Daniel 2026-09-03: «fiks den byttede teksten på Epleblomsten og Nordlysmat.»
//
// The English translation run that day had three independent reviewers each
// find half of the same defect without knowing of each other: `Epleblomsten
// — Telemark` (Sauherad) carried Nordlysmat's Finnmark herbs-and-berries
// text, and `Nordlysmat Drift AS` (Alta) carried Epleblomsten's Midt-Telemark
// cider text — the two descriptions were swapped. Confirmed live in
// production the same afternoon. Two more wrong-entity rows were found in the
// same run (Nordlandtiroler, Romstad Gård).
//
// ── Why a new route instead of PUT /admin/knowledge ─────────────────────
// There was NO honest write path for a human-established content correction:
//   - PUT /admin/knowledge is the automated-enrichment door. Overwriting a
//     populated description there goes through canCorrectFactualField, which
//     is built to weigh SOURCE PROVENANCE (homepage vs google_places, Tier-A
//     counts) — a correction a person has established by reading both rows
//     has no such provenance, and the only way through would have been to
//     fabricate some. That is exactly the kind of quiet misrepresentation
//     the provenance system exists to prevent.
//   - curated_fields is only ever set by the producer in the owner portal.
// So this route IS that path: an explicit, per-row, reason-carrying,
// audited correction. It never scans or infers anything — every target row
// and every new value is named by the caller, and the reason is mandatory
// and lands in the audit row, where a later reader can see WHO decided WHAT
// and WHY. changed_by is 'admin' (a person directed this), not 'system'.
//
// Write discipline is copied from admin-agents-url-write.ts / the
// code-artifact sweep: dry-run by default; owner-lock (claimed_at OR a
// verified agent_claims row) and curated_fields-lock re-read FRESH inside
// each row's own transaction; per-row transaction so one failure never
// aborts the batch; enrichment-write-pause gate on the caller's id set,
// before the dry-run branch, fails CLOSED. The incoming text passes the
// same two content gates as every other description/about door
// (looksLikeCodeArtifact, hasInternalNote) — a correction must never be the
// way junk gets back in.
//
// Body: { apply?: boolean, reason: string, items: [ItemSpec] }, ItemSpec one of
//   { agent_id, field: "description"|"about", text }
//   { agent_id, field: "product_name", old_name, text }  — renames the ONE
//       agent_knowledge.products entry whose name === old_name (0 or >1
//       matches -> invalid_item); every other product field kept. Entries
//       come in two kinds and both are matched: objects ({ name, ... }, name
//       compared) and plain strings (some producers store `products` as
//       ["Poteter", "Gulrot"], or a mix; the string itself is compared). A
//       renamed string entry is replaced by the string `text` — it stays a
//       string, never becomes an object. If `text` already names another
//       product of either kind (exact, or equal after the catalog's
//       case/whitespace normalisation): would_merge / merged — the entry with
//       more populated fields is kept (a string has none; tie: the one already
//       named `text`), named `text` and kept in its own kind, the other
//       dropped; reported in `merge` + audit notes.
//   { agent_id, field: "products_organic_flag" }  — organic=false on every
//       product with a truthy organic.
//   { agent_id, field: "specialties"|"certifications"|"tags", remove: string[] }
//       — removes exact-match elements (agent_knowledge.specialties /
//       .certifications, agents.tags); absent ones listed in
//       not_found_elements. Never adds.
// Same locks for all: owner lock -> skipped_claimed; curated_fields key
// (products / the list name) -> skipped_curated; nothing to change ->
// skipped_unchanged (no audit). One audit row per applied change, field_name
// = the stored column, full old/new JSON value.
//
// ── product_name and the `products` catalog table ───────────────────────
// The catalog (`products`, UNIQUE(agent_id, name_norm)) is filled from
// agent_knowledge.products by product-catalog-sync.ts, which only upserts.
// Left alone, a renamed product's old-name row would stay listed forever
// next to the new one (the false «økologisk» name in /catalog/feed, offers,
// lokal_search, cart add). So a rename also fixes the catalog, in the same
// per-row transaction, located by the sync's own key
// (normalizeName(parseProductPrice(entry).cleanName)):
//   - no row for the old key            -> catalog.action "none";
//   - no row for the new key yet        -> "rename_in_place": the old row's
//       name/name_norm become the new one; products.id is kept, so
//       cart_items.product_id / cart_wishes.chosen_product_id still point
//       at it, and the next sync updates that same row;
//   - a row for the new key exists (merge, or a stale catalog row), or the
//     new name has no catalog key       -> the old row is retired:
//       "retire_delete" when nothing references its id (no FK points at
//       products; order_items carry name snapshots), else
//       "retire_out_of_stock" (availability='out_of_stock', which the feeds
//       and cart/orderability already exclude; kept so a cart reference
//       does not dangle).
// The effect is reported per item (`catalog`, also on dry-run, which writes
// nothing) and appended to the audit notes with the full old catalog row, so
// it can be rolled back.
// Plain-string product entries are never in the catalog (the sync only lists
// object entries with a string `name`), so renaming one is always catalog
// action "none" and never touches `products` — also when it merges into an
// object duplicate (that object's catalog row already carries `text`'s key).
// An object entry merged into a string duplicate keeps the object behaviour
// above (planned from the renamed object's old key to the new name).
// Max 50 items per call — this is a targeted lever, not a sweep.
//
// ── Owner consent (S2e, dev-request 2026-10-28-rfb-okologisk-merking-…) ──
// The owner lock used to be absolute: every owner-locked profile came back
// skipped_claimed, whatever the owner had said. For the organic-labelling
// text revision we e-mailed owner-locked producers asking them to reply «ja»
// to a text fix, so a «ja» needs an honest, audited way through. Any item may
// carry `owner_consent: { crm_message_id }` (null/absent = no consent; any
// other shape, or an empty / over-long id -> invalid_item). It is checked —
// in dry-run too, and re-read FRESH inside the apply's per-row transaction,
// like the lock itself — only when the row IS owner-locked. Consent is valid
// only if the crm_messages row exists, is direction='in', its thread's
// contact has crm_contacts.agent_id = the item's agent_id, it was sent FROM
// that contact (lower(trim(from_email)) = lower(trim(crm_contacts.email)) —
// a CC'd third party replying on the thread is not the owner), and some
// thread with the SAME contact_id (any thread — S2e-2: a reply to our notice
// is often imported as a new thread) holds an earlier direction='out' message
// that was actually sent (delivery_status='sent'; a queued/drafted/failed row
// never reached the owner), at most 30 days before the reply. «Earlier»
// compares julianday(COALESCE(sent_at, received_at)) on both sides, strictly
// (julianday() normalises ISO «T…Z» and SQLite «YYYY-MM-DD HH:MM:SS» alike).
// Outbound to other contacts of the same agent does not count. The spec
// reads «received after the last outbound message with the owner notice»; we
// cannot identify the notice message generically, and requiring the reply to
// postdate the very LAST outbound would void the consent as soon as we reply
// to confirm it — so the rule is «a reply after some outbound we sent to that
// contact». The latest qualifying outbound is recorded as
// basis_outbound_message_id in the crm_actions payload. Otherwise
// invalid_consent and nothing is written. Valid consent bypasses the OWNER
// LOCK ONLY: curated_fields, junk gates, unchanged, dry-run default and the
// per-row transaction all still apply. Outcomes: would_write_with_owner_consent
// / written_with_owner_consent (would_merge_… / merged_… for a product_name
// merge). The audit notes get ` · owner_consent=<id>` after the reason, and
// the same transaction inserts a crm_actions row (type owner_consent_applied,
// actor system) on the reply message's thread/contact. On a row that is NOT
// owner-locked, owner_consent is ignored (not checked) and the outcome is the
// normal one — consent is never claimed where it was not what let it through.
// Without owner_consent behaviour is unchanged (skipped_claimed).
// Residual risk: the route is admin-key only and every consent write is
// audited (audit notes + crm_actions), but the check proves «the contact
// replied after we wrote», not WHAT they agreed to — the admin caller is
// trusted to cite a reply that really is a «ja» to this fix. One consent
// message can also be reused across fields/items/calls for the same agent;
// the crm_actions trail makes such reuse visible, it does not prevent it.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { hasInternalNote, looksLikeCodeArtifact, looksLikeThemeSpam } from "../services/description-quality";
import { isProductHeader, isProductNoise, parseProductPrice } from "../services/knowledge-service";
import { normalizeName } from "../services/product-catalog-sync";
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

export const CONTENT_CORRECTION_MAX_ITEMS = 50;
export const CONTENT_CORRECTION_MAX_TEXT = 8000;

let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
export function __setContentCorrectionDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function db_(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

function previewValue(s: string | null | undefined, maxLen = 80): string {
  const v = s ?? "";
  if (v.length <= maxLen) return v;
  return v.slice(0, maxLen) + "…";
}

type TextField = "description" | "about";
type ListField = "specialties" | "certifications" | "tags";
type Field = TextField | "product_name" | "products_organic_flag" | ListField;

const LIST_FIELDS: readonly ListField[] = ["specialties", "certifications", "tags"];
export const CONTENT_CORRECTION_MAX_PRODUCT_NAME = 200;
export const CONTENT_CORRECTION_MAX_REMOVE = 100;
export const CONTENT_CORRECTION_MAX_CONSENT_ID = 200;

type ItemOutcome =
  | "would_write"
  | "written"
  | "would_merge"
  | "merged"
  | "would_write_with_owner_consent"
  | "written_with_owner_consent"
  | "would_merge_with_owner_consent"
  | "merged_with_owner_consent"
  | "invalid_consent"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "skipped_malformed_json"
  | "refused_junk_text"
  | "invalid_item"
  | "not_found"
  | "error";

/** product_name merge record: which product row was kept, which dropped. */
interface MergeInfo {
  kept: "renamed_row" | "existing_row";
  kept_product: unknown;
  dropped_product: unknown;
}

/** What a product_name item does (or would do) to the `products` catalog. */
interface CatalogEffect {
  action: "none" | "rename_in_place" | "retire_delete" | "retire_out_of_stock";
  applied?: boolean;
  product_id?: string;
  old_name?: string;
  new_name?: string;
  old_name_norm?: string;
  new_name_norm?: string;
  /** The catalog row already carrying the new name (retire cases). */
  existing_product_id?: string;
  references?: { cart_items: number; cart_wishes: number };
  /** Full old catalog row — for rollback (retire / rename). */
  old_row?: Record<string, unknown>;
  detail?: string;
}

interface ResultItem {
  agent_id: string;
  field?: Field;
  name?: string;
  outcome: ItemOutcome;
  old_value_preview?: string;
  new_value_preview?: string;
  detail?: string;
  merge?: MergeInfo;
  removed?: string[];
  not_found_elements?: string[];
  changed_count?: number;
  catalog?: CatalogEffect;
}

interface LockSnapshot {
  name: string;
  claimed_at: string | null;
  description: string;
  about: string | null;
  products: string | null;
  specialties: string | null;
  certifications: string | null;
  tags: string | null;
  curated_fields: string | null;
  verified_claims: number;
  has_knowledge_row: number;
}

const LOCK_SNAPSHOT_SQL = `
  SELECT a.name         AS name,
         a.claimed_at   AS claimed_at,
         a.description  AS description,
         a.tags         AS tags,
         k.about        AS about,
         k.products     AS products,
         k.specialties  AS specialties,
         k.certifications AS certifications,
         k.curated_fields AS curated_fields,
         (SELECT COUNT(*) FROM agent_claims c
           WHERE c.agent_id = a.id AND c.status = 'verified') AS verified_claims,
         (k.agent_id IS NOT NULL) AS has_knowledge_row
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
   WHERE a.id = ?`;

function isOwnerLocked(s: { claimed_at: string | null; verified_claims: number }): boolean {
  return !!s.claimed_at || (s.verified_claims ?? 0) > 0;
}

function isFieldCurated(curatedFieldsJson: string | null | undefined, fieldName: string): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    return !!(parsed as Record<string, unknown>)[fieldName];
  } catch {
    return false;
  }
}

/**
 * The stored column a field writes to — also the audit field_name and the
 * curated_fields key that locks it (owner-portal keys curated_fields by
 * column name). Lists: specialties/certifications are agent_knowledge JSON
 * columns, tags is the agents.tags JSON column.
 */
function storageColumn(field: Field): TextField | "products" | ListField {
  if (field === "product_name" || field === "products_organic_flag") return "products";
  return field;
}

interface OwnerConsent {
  crm_message_id: string;
}

type ValidItem = (
  | { agent_id: string; field: TextField; text: string }
  | { agent_id: string; field: "product_name"; old_name: string; text: string }
  | { agent_id: string; field: "products_organic_flag" }
  | { agent_id: string; field: ListField; remove: string[] }
) & { owner_consent?: OwnerConsent };

/** S2e-2: how old (days before the reply) our outbound notice may be. */
const CONSENT_OUTBOUND_MAX_AGE_DAYS = 30;

/** Result of the (fresh) owner-consent check for one item. */
type ConsentCheck =
  | { ok: true; crm_message_id: string; thread_id: string; contact_id: string; basis_outbound_id: string }
  | { ok: false; crm_message_id: string; detail: string };

/**
 * Is `crm_message_id` a valid owner consent for `agentId`? See the header
 * (S2e) for the rule and why «earlier outbound», not «after the last one».
 * Read-only; called inside the per-row transaction on apply.
 */
function checkOwnerConsent(db: ReturnType<typeof getDb>, agentId: string, crmMessageId: string): ConsentCheck {
  const bad = (detail: string): ConsentCheck => ({ ok: false, crm_message_id: crmMessageId, detail });
  const m = db.prepare(
    `SELECT m.direction AS direction, m.thread_id AS thread_id, t.contact_id AS contact_id,
            c.agent_id AS contact_agent_id,
            (lower(trim(m.from_email)) = lower(trim(c.email))) AS from_contact,
            julianday(COALESCE(m.sent_at, m.received_at)) AS ts
       FROM crm_messages m
       JOIN crm_threads t ON t.id = m.thread_id
       LEFT JOIN crm_contacts c ON c.id = t.contact_id
      WHERE m.id = ?`,
  ).get(crmMessageId) as
    | { direction: string; thread_id: string; contact_id: string; contact_agent_id: string | null; from_contact: number | null; ts: number | null }
    | undefined;
  if (!m) return bad("owner_consent: crm message not found");
  if (m.direction !== "in") return bad("owner_consent: crm message is not inbound");
  if (!m.contact_agent_id || m.contact_agent_id !== agentId) {
    return bad("owner_consent: crm message's contact does not belong to this agent");
  }
  // The reply must come FROM the contact (not a CC'd third party on the thread).
  if (!m.from_contact) return bad("owner_consent: sender is not the profile's contact");
  if (m.ts == null) return bad("owner_consent: crm message has no usable timestamp");
  // S2e-2: our notice may sit in ANY thread with the same contact (a reply is
  // often imported as a new thread), but must be sent strictly before the
  // reply and at most CONSENT_OUTBOUND_MAX_AGE_DAYS before it. The latest such
  // outbound is recorded as the basis in crm_actions.
  const basis = db.prepare(
    `SELECT o.id AS id FROM crm_messages o
       JOIN crm_threads ot ON ot.id = o.thread_id
      WHERE ot.contact_id = ? AND o.direction = 'out' AND o.delivery_status = 'sent'
        AND julianday(COALESCE(o.sent_at, o.received_at)) < ?
        AND julianday(COALESCE(o.sent_at, o.received_at)) >= ? - ?
      ORDER BY julianday(COALESCE(o.sent_at, o.received_at)) DESC, o.id DESC
      LIMIT 1`,
  ).get(m.contact_id, m.ts, m.ts, CONSENT_OUTBOUND_MAX_AGE_DAYS) as { id: string } | undefined;
  if (!basis) {
    return bad(
      `owner_consent: no sent outbound message to this contact in the ${CONSENT_OUTBOUND_MAX_AGE_DAYS} days before the reply — not a reply to our notice`,
    );
  }
  return { ok: true, crm_message_id: crmMessageId, thread_id: m.thread_id, contact_id: m.contact_id, basis_outbound_id: basis.id };
}

/** Outcome as reported: *_with_owner_consent when consent is what let it through. */
function reportedOutcome(outcome: ItemOutcome, viaOwnerConsent: boolean | undefined): ItemOutcome {
  if (!viaOwnerConsent) return outcome;
  if (outcome === "would_write") return "would_write_with_owner_consent";
  if (outcome === "would_merge") return "would_merge_with_owner_consent";
  if (outcome === "written") return "written_with_owner_consent";
  if (outcome === "merged") return "merged_with_owner_consent";
  return outcome;
}

type Invalid = { ok: false; outcome: ItemOutcome; detail: string; agent_id: string };

/** The same content gates as every other description/about door. */
function junkGate(text: string, agentId: string): Invalid | null {
  if (looksLikeCodeArtifact(text)) return { ok: false, outcome: "refused_junk_text", detail: "text looks like a code artifact", agent_id: agentId };
  if (hasInternalNote(text)) return { ok: false, outcome: "refused_junk_text", detail: "text contains an internal pipeline note", agent_id: agentId };
  // dev-request 2026-09-16-kaprede-produsentdomener-kasino-spam-i-beskrivelser.
  if (looksLikeThemeSpam(text)) return { ok: false, outcome: "refused_junk_text", detail: "text looks like gambling/theme spam (hijacked domain)", agent_id: agentId };
  return null;
}

/**
 * Shape + content validation of one caller-supplied item, including the
 * optional owner_consent (S2e): absent or null = none; otherwise it must be
 * { crm_message_id: non-empty string <= CONTENT_CORRECTION_MAX_CONSENT_ID }.
 */
function validateItem(raw: unknown): { ok: true; item: ValidItem } | Invalid {
  const v = validateItemFields(raw);
  if (!v.ok) return v;
  const oc = ((raw ?? {}) as Record<string, unknown>).owner_consent;
  if (oc === undefined || oc === null) return v;
  const id = oc && typeof oc === "object" && !Array.isArray(oc) ? (oc as Record<string, unknown>).crm_message_id : undefined;
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!trimmed) {
    return { ok: false, outcome: "invalid_item", detail: "owner_consent must be { crm_message_id: non-empty string }", agent_id: v.item.agent_id };
  }
  if (trimmed.length > CONTENT_CORRECTION_MAX_CONSENT_ID) {
    return { ok: false, outcome: "invalid_item", detail: `owner_consent.crm_message_id exceeds ${CONTENT_CORRECTION_MAX_CONSENT_ID} chars`, agent_id: v.item.agent_id };
  }
  return { ok: true, item: { ...v.item, owner_consent: { crm_message_id: trimmed } } };
}

function validateItemFields(raw: unknown): { ok: true; item: ValidItem } | Invalid {
  const r = (raw ?? {}) as Record<string, unknown>;
  const agentId = typeof r.agent_id === "string" ? r.agent_id.trim() : "";
  if (!agentId) return { ok: false, outcome: "invalid_item", detail: "agent_id required", agent_id: "" };
  const f = r.field;

  if (f === "description" || f === "about") {
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) return { ok: false, outcome: "invalid_item", detail: "text required (non-empty)", agent_id: agentId };
    if (text.length > CONTENT_CORRECTION_MAX_TEXT) {
      return { ok: false, outcome: "invalid_item", detail: `text exceeds ${CONTENT_CORRECTION_MAX_TEXT} chars`, agent_id: agentId };
    }
    // A correction is never the way junk gets back in.
    const junk = junkGate(text, agentId);
    if (junk) return junk;
    return { ok: true, item: { agent_id: agentId, field: f, text } };
  }

  if (f === "product_name") {
    // old_name is matched EXACTLY against the stored name — not trimmed.
    const oldName = typeof r.old_name === "string" ? r.old_name : "";
    if (!oldName) return { ok: false, outcome: "invalid_item", detail: "old_name required (non-empty)", agent_id: agentId };
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) return { ok: false, outcome: "invalid_item", detail: "text required (non-empty)", agent_id: agentId };
    if (text.length > CONTENT_CORRECTION_MAX_PRODUCT_NAME) {
      return { ok: false, outcome: "invalid_item", detail: `text exceeds ${CONTENT_CORRECTION_MAX_PRODUCT_NAME} chars`, agent_id: agentId };
    }
    const junk = junkGate(text, agentId);
    if (junk) return junk;
    return { ok: true, item: { agent_id: agentId, field: "product_name", old_name: oldName, text } };
  }

  if (f === "products_organic_flag") {
    return { ok: true, item: { agent_id: agentId, field: "products_organic_flag" } };
  }

  if (typeof f === "string" && (LIST_FIELDS as readonly string[]).includes(f)) {
    const remove = r.remove;
    if (!Array.isArray(remove) || remove.length === 0) {
      return { ok: false, outcome: "invalid_item", detail: "remove[] required (non-empty array of strings)", agent_id: agentId };
    }
    if (remove.length > CONTENT_CORRECTION_MAX_REMOVE) {
      return { ok: false, outcome: "invalid_item", detail: `remove[] exceeds ${CONTENT_CORRECTION_MAX_REMOVE} elements`, agent_id: agentId };
    }
    if (!remove.every((e) => typeof e === "string" && e.length > 0)) {
      return { ok: false, outcome: "invalid_item", detail: "remove[] elements must be non-empty strings", agent_id: agentId };
    }
    return { ok: true, item: { agent_id: agentId, field: f as ListField, remove: [...new Set(remove as string[])] } };
  }

  return {
    ok: false,
    outcome: "invalid_item",
    detail: "field must be description|about|product_name|products_organic_flag|specialties|certifications|tags",
    agent_id: agentId,
  };
}

/** Parse a stored JSON-array column. null/'' -> []; non-array or bad JSON -> null (malformed). */
function parseJsonArray(stored: string | null | undefined): unknown[] | null {
  if (stored == null || stored === "") return [];
  try {
    const v = JSON.parse(stored);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function isProductObj(p: unknown): p is Record<string, unknown> {
  return !!p && typeof p === "object" && !Array.isArray(p);
}

/**
 * The name of one stored products entry: a plain string entry is its own
 * name, an object entry its string `name`. undefined for anything else.
 */
function productEntryName(p: unknown): string | undefined {
  if (typeof p === "string") return p;
  if (isProductObj(p) && typeof p.name === "string") return p.name;
  return undefined;
}

/** `entry` renamed to `name`, kept in its own kind (string stays string). */
function withProductName(entry: unknown, name: string): unknown {
  return typeof entry === "string" ? name : { ...(entry as Record<string, unknown>), name };
}

/** Populated non-name fields of an entry; a plain string entry has none. */
function entryFieldCount(entry: unknown): number {
  return isProductObj(entry) ? populatedFieldCount(entry) : 0;
}

/** How many fields besides `name` carry a value — the merge tie-breaker. */
function populatedFieldCount(p: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (k === "name") continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    n++;
  }
  return n;
}

/**
 * The change one item would make, computed against a lock snapshot. Pure
 * apart from the (read-only) owner-consent lookup it is handed — shared by the
 * dry-run and by the apply's fresh in-transaction re-check, so both always
 * agree on the outcome. `newValue` is the full new column value.
 */
interface Plan {
  outcome: ItemOutcome;
  column?: TextField | "products" | ListField;
  oldValue?: string | null;
  newValue?: string;
  oldPreview?: string | null;
  newPreview?: string | null;
  detail?: string;
  merge?: MergeInfo;
  removed?: string[];
  not_found_elements?: string[];
  changed_count?: number;
  /**
   * product_name: the stored OBJECT entry being renamed (before the rename).
   * Unset for a plain-string entry — those never reach planCatalog.
   */
  renamedEntry?: Record<string, unknown>;
  /** product_name: the renamed entry is a plain string (not in the catalog). */
  renamedStringEntry?: boolean;
  /** S2e: the owner lock was passed on valid owner consent (thread/contact for crm_actions). */
  viaOwnerConsent?: { crm_message_id: string; thread_id: string; contact_id: string; basis_outbound_id: string };
}

/**
 * The owner-lock step of plan(): null = proceed (not locked); otherwise the
 * outcome to stop at, or `consent` = proceed on valid owner consent (S2e).
 */
function ownerLockGate(
  cur: LockSnapshot,
  consent: ConsentCheck | undefined,
): { stop: ItemOutcome; detail?: string } | { consent: Plan["viaOwnerConsent"] } | null {
  if (!isOwnerLocked(cur)) return null;
  if (!consent) return { stop: "skipped_claimed" };
  if (!consent.ok) return { stop: "invalid_consent", detail: consent.detail };
  return {
    consent: {
      crm_message_id: consent.crm_message_id,
      thread_id: consent.thread_id,
      contact_id: consent.contact_id,
      basis_outbound_id: consent.basis_outbound_id,
    },
  };
}

/**
 * The catalog key the sync gives one product entry — the same steps as
 * runProductCatalogSync (header/noise skipped, parseProductPrice cleanName,
 * normalizeName). "" when the sync would not list it.
 */
function catalogKeyOf(entry: Record<string, unknown>): { key: string; cleanName: string } {
  const raw = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!raw || isProductHeader(raw) || isProductNoise(raw)) return { key: "", cleanName: "" };
  const { cleanName } = parseProductPrice(entry as any);
  if (!cleanName) return { key: "", cleanName: "" };
  return { key: normalizeName(cleanName), cleanName };
}

/** Read-only: what renaming `entry` to `newName` does to the catalog. */
function planCatalog(db: ReturnType<typeof getDb>, agentId: string, entry: Record<string, unknown>, newName: string): CatalogEffect {
  const oldK = catalogKeyOf(entry);
  if (!oldK.key) return { action: "none", detail: "old product name has no catalog key" };
  const oldRow = db.prepare(`SELECT * FROM products WHERE agent_id = ? AND name_norm = ?`).get(agentId, oldK.key) as
    | Record<string, unknown>
    | undefined;
  if (!oldRow) return { action: "none", old_name_norm: oldK.key, detail: "no catalog row for the old name" };
  const newK = catalogKeyOf({ ...entry, name: newName });
  const base: CatalogEffect = {
    action: "none",
    product_id: oldRow.id as string,
    old_name: oldRow.name as string,
    new_name: newK.cleanName || undefined,
    old_name_norm: oldK.key,
    new_name_norm: newK.key || undefined,
    old_row: oldRow,
  };
  const existing = newK.key && newK.key !== oldK.key
    ? (db.prepare(`SELECT id FROM products WHERE agent_id = ? AND name_norm = ?`).get(agentId, newK.key) as { id: string } | undefined)
    : undefined;
  if (newK.key && !existing) {
    if (newK.key === oldK.key && oldRow.name === newK.cleanName) return { ...base, detail: "catalog row already carries the new name" };
    return { ...base, action: "rename_in_place" };
  }
  const refs = {
    cart_items: (db.prepare(`SELECT COUNT(*) AS n FROM cart_items WHERE product_id = ?`).get(oldRow.id) as { n: number }).n,
    cart_wishes: (db.prepare(`SELECT COUNT(*) AS n FROM cart_wishes WHERE chosen_product_id = ?`).get(oldRow.id) as { n: number }).n,
  };
  const retired: CatalogEffect = { ...base, existing_product_id: existing?.id, references: refs };
  if (!newK.key) retired.detail = "new name has no catalog key (the sync would not list it)";
  return { ...retired, action: refs.cart_items + refs.cart_wishes > 0 ? "retire_out_of_stock" : "retire_delete" };
}

function applyCatalog(db: ReturnType<typeof getDb>, c: CatalogEffect): void {
  if (c.action === "rename_in_place") {
    db.prepare(`UPDATE products SET name = ?, name_norm = ?, updated_at = datetime('now') WHERE id = ?`).run(c.new_name, c.new_name_norm, c.product_id);
  } else if (c.action === "retire_delete") {
    db.prepare(`DELETE FROM products WHERE id = ?`).run(c.product_id);
  } else if (c.action === "retire_out_of_stock") {
    db.prepare(`UPDATE products SET availability = 'out_of_stock', updated_at = datetime('now') WHERE id = ?`).run(c.product_id);
  }
}

/**
 * `consentFor` is called (lazily) only when the row is owner-locked and the
 * item carries owner_consent — an unlocked row never checks or claims consent.
 */
function plan(cur: LockSnapshot | undefined, item: ValidItem, consentFor?: () => ConsentCheck): Plan {
  if (!cur) return { outcome: "not_found" };
  const column = storageColumn(item.field);
  const gate = ownerLockGate(cur, isOwnerLocked(cur) && item.owner_consent && consentFor ? consentFor() : undefined);
  const viaOwnerConsent = gate && "consent" in gate ? gate.consent : undefined;
  const stop = gate && "stop" in gate ? gate : undefined;

  if (item.field === "description" || item.field === "about") {
    const oldValue = item.field === "description" ? cur.description : cur.about;
    const base: Plan = { outcome: "would_write", column, oldValue, oldPreview: oldValue, newPreview: item.text, viaOwnerConsent };
    if (stop) return { ...base, outcome: stop.stop, detail: stop.detail, viaOwnerConsent: undefined };
    if (isFieldCurated(cur.curated_fields, item.field)) return { ...base, outcome: "skipped_curated" };
    if ((oldValue ?? "") === item.text) return { ...base, outcome: "skipped_unchanged" };
    return { ...base, outcome: "would_write", newValue: item.text };
  }

  const oldValue = (cur as unknown as Record<string, string | null>)[column] ?? null;
  const base: Plan = { outcome: "would_write", column, oldValue, viaOwnerConsent };
  if (stop) return { ...base, outcome: stop.stop, detail: stop.detail, viaOwnerConsent: undefined };
  if (isFieldCurated(cur.curated_fields, column)) return { ...base, outcome: "skipped_curated" };
  const arr = parseJsonArray(oldValue);
  if (!arr) return { ...base, outcome: "skipped_malformed_json", detail: `stored ${column} is not a JSON array` };

  if (item.field === "product_name") {
    const sel: Plan = { ...base, oldPreview: item.old_name, newPreview: item.text };
    // Exact equality against both kinds: object `name`, or the string itself.
    const matches = arr.map((p, i) => (productEntryName(p) === item.old_name ? i : -1)).filter((i) => i >= 0);
    if (matches.length !== 1) {
      return { ...sel, outcome: "invalid_item", detail: `old_name matches ${matches.length} products (need exactly 1)` };
    }
    const idx = matches[0];
    if (item.old_name === item.text) return { ...sel, outcome: "skipped_unchanged" };
    // A duplicate is a product (string or object) already named `text` —
    // exactly, or equal under the catalog's case/whitespace normalisation.
    const textNorm = normalizeName(item.text);
    const dupes = arr
      .map((p, i) => {
        if (i === idx) return -1;
        const n = productEntryName(p);
        return n !== undefined && (n === item.text || normalizeName(n) === textNorm) ? i : -1;
      })
      .filter((i) => i >= 0);
    if (dupes.length > 1) {
      return { ...sel, outcome: "invalid_item", detail: `text already names ${dupes.length} products — ambiguous merge` };
    }
    const renamed = arr[idx];
    if (typeof renamed === "string") sel.renamedStringEntry = true;
    else sel.renamedEntry = renamed as Record<string, unknown>;
    if (dupes.length === 0) {
      // Object: spread keeps key order and every other field; only `name`
      // changes. String: replaced by the string `text`.
      const next = arr.slice();
      next[idx] = withProductName(renamed, item.text);
      return { ...sel, outcome: "would_write", newValue: JSON.stringify(next) };
    }
    // Merge: keep the row with the most populated fields; tie -> the row
    // that already carries `text`. Kept row ends up named `text` (in its own
    // kind), the other is dropped; the kept row stays at its own position.
    const dupIdx = dupes[0];
    const existing = arr[dupIdx];
    const keepRenamed = entryFieldCount(renamed) > entryFieldCount(existing);
    const keptProduct = withProductName(keepRenamed ? renamed : existing, item.text);
    const droppedIdx = keepRenamed ? dupIdx : idx;
    const keptIdx = keepRenamed ? idx : dupIdx;
    const next: unknown[] = [];
    arr.forEach((p, i) => {
      if (i === droppedIdx) return;
      next.push(i === keptIdx ? keptProduct : p);
    });
    return {
      ...sel,
      outcome: "would_merge",
      newValue: JSON.stringify(next),
      merge: {
        kept: keepRenamed ? "renamed_row" : "existing_row",
        kept_product: keptProduct,
        dropped_product: arr[droppedIdx],
      },
    };
  }

  if (item.field === "products_organic_flag") {
    let changed = 0;
    const next = arr.map((p) => {
      if (isProductObj(p) && p.organic) {
        changed++;
        return { ...p, organic: false };
      }
      return p;
    });
    if (changed === 0) return { ...base, outcome: "skipped_unchanged", changed_count: 0 };
    return { ...base, outcome: "would_write", newValue: JSON.stringify(next), changed_count: changed };
  }

  // List removal — exact string equality, never adds.
  if (!("remove" in item)) return { outcome: "error", detail: "unreachable: unhandled field" };
  const toRemove = new Set(item.remove);
  const present = new Set(arr.filter((e): e is string => typeof e === "string"));
  const removed = item.remove.filter((e) => present.has(e));
  const notFound = item.remove.filter((e) => !present.has(e));
  const out = { ...base, removed, not_found_elements: notFound };
  if (removed.length === 0) return { ...out, outcome: "skipped_unchanged" };
  const next = arr.filter((e) => !(typeof e === "string" && toRemove.has(e)));
  return { ...out, outcome: "would_write", newValue: JSON.stringify(next) };
}

type ApplyResult = Plan & { name?: string; catalog?: CatalogEffect };

function catalogFor(db: ReturnType<typeof getDb>, item: ValidItem, p: Plan): CatalogEffect | undefined {
  if (item.field !== "product_name") return undefined;
  if (p.outcome !== "would_write" && p.outcome !== "would_merge") return undefined;
  // A plain-string entry is never in the catalog — never touch `products`.
  if (p.renamedStringEntry) return { action: "none", detail: "string product entry is not in the catalog" };
  if (!p.renamedEntry) return undefined;
  return planCatalog(db, item.agent_id, p.renamedEntry, item.text);
}

/** Lazy owner-consent check for plan() — undefined when the item carries none. */
function consentChecker(db: ReturnType<typeof getDb>, item: ValidItem): (() => ConsentCheck) | undefined {
  const oc = item.owner_consent;
  return oc ? () => checkOwnerConsent(db, item.agent_id, oc.crm_message_id) : undefined;
}

/** Write ONE correction — fresh lock re-read inside its own transaction. */
function applyCorrection(item: ValidItem, reason: string, batchTag: string): ApplyResult {
  const db = db_();
  try {
    const tx = db.transaction((): ApplyResult => {
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(item.agent_id) as LockSnapshot | undefined;
      // Owner consent is re-checked here, fresh, inside this row's transaction.
      const p = plan(cur, item, consentChecker(db, item));
      if (p.outcome !== "would_write" && p.outcome !== "would_merge") return { ...p, name: cur?.name };

      const nowIso = new Date().toISOString();
      const col = p.column!;
      const newValue = p.newValue!;
      if (col === "description") {
        db.prepare(`UPDATE agents SET description = ? WHERE id = ?`).run(newValue, item.agent_id);
      } else if (col === "tags") {
        db.prepare(`UPDATE agents SET tags = ? WHERE id = ?`).run(newValue, item.agent_id);
      } else if (col === "about" && !cur!.has_knowledge_row) {
        db.prepare(`INSERT INTO agent_knowledge (agent_id, about, updated_at) VALUES (?, ?, ?)`).run(item.agent_id, newValue, nowIso);
      } else {
        // about / products / specialties / certifications — a list change is
        // only ever planned against an existing row (no row -> [] -> nothing to change).
        db.prepare(`UPDATE agent_knowledge SET ${col} = ?, updated_at = ? WHERE agent_id = ?`).run(newValue, nowIso, item.agent_id);
      }
      const catalog = catalogFor(db, item, p);
      if (catalog) {
        applyCatalog(db, catalog);
        catalog.applied = catalog.action !== "none";
      }
      let notes = `${batchTag}: ${reason}`;
      const consent = p.viaOwnerConsent;
      if (consent) notes += ` · owner_consent=${consent.crm_message_id}`;
      if (p.merge) {
        notes += ` [merge: kept ${p.merge.kept} ${JSON.stringify(p.merge.kept_product)}; dropped ${JSON.stringify(p.merge.dropped_product)}]`;
      }
      if (catalog) notes += ` [catalog: ${JSON.stringify(catalog)}]`;
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, ?, ?, ?, 'admin', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), item.agent_id, col, p.oldValue ?? null, newValue, notes);
      if (consent) {
        db.prepare(
          `INSERT INTO crm_actions (id, thread_id, contact_id, type, actor, payload)
           VALUES (?, ?, ?, 'owner_consent_applied', 'system', ?)`,
        ).run(
          randomUUID(),
          consent.thread_id,
          consent.contact_id,
          JSON.stringify({
            agent_id: item.agent_id,
            field: item.field,
            crm_message_id: consent.crm_message_id,
            basis_outbound_message_id: consent.basis_outbound_id,
            batch_tag: batchTag,
          }),
        );
      }
      const written: ItemOutcome = p.outcome === "would_merge" ? "merged" : "written";
      return { ...p, outcome: reportedOutcome(written, !!consent), name: cur!.name, catalog };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

function toResult(item: ValidItem, p: ApplyResult): ResultItem {
  const r: ResultItem = {
    agent_id: item.agent_id,
    field: item.field,
    name: p.name,
    outcome: p.outcome,
    old_value_preview: previewValue(p.oldPreview !== undefined ? p.oldPreview : p.oldValue),
    new_value_preview: previewValue(
      p.newPreview !== undefined ? p.newPreview : p.newValue !== undefined ? p.newValue : "text" in item ? item.text : undefined,
    ),
  };
  if (p.detail) r.detail = p.detail;
  if (p.merge) r.merge = p.merge;
  if (p.removed) r.removed = p.removed;
  if (p.not_found_elements) r.not_found_elements = p.not_found_elements;
  if (p.changed_count !== undefined) r.changed_count = p.changed_count;
  if (p.catalog) r.catalog = p.catalog;
  return r;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { apply?: unknown; reason?: unknown; items?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "reason required — every correction must say why (it lands in the audit row)" });
    return;
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    res.status(400).json({ error: "items[] required" });
    return;
  }
  if (body.items.length > CONTENT_CORRECTION_MAX_ITEMS) {
    res.status(400).json({ error: `max ${CONTENT_CORRECTION_MAX_ITEMS} items per call` });
    return;
  }

  const results: ResultItem[] = [];
  const valid: ValidItem[] = [];
  for (const raw of body.items) {
    const v = validateItem(raw);
    if (v.ok) valid.push(v.item);
    else results.push({ agent_id: v.agent_id, outcome: v.outcome, detail: v.detail });
  }

  // Enrichment write-pause gate — on the caller's id set, before dry-run,
  // fails CLOSED and blocks the WHOLE request (same as the siblings).
  {
    const pauseBlock = enrichmentWritePauseBlockForAgents(db_, valid.map((i) => i.agent_id));
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const batchTag = `content-correction-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const db = db_();
  for (const item of valid) {
    if (dryRun) {
      // Dry-run reports the lock state too, so the caller sees what WOULD be
      // refused before spending an apply on it.
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(item.agent_id) as LockSnapshot | undefined;
      const p = plan(cur, item, consentChecker(db, item));
      const catalog = catalogFor(db, item, p);
      results.push(toResult(item, { ...p, outcome: reportedOutcome(p.outcome, !!p.viaOwnerConsent), name: cur?.name, catalog }));
    } else {
      results.push(toResult(item, applyCorrection(item, reason, batchTag)));
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc), {});
  res.json({ success: true, dry_run: dryRun, batch_tag: batchTag, reason, counts, results });
});

export default router;
