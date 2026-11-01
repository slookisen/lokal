// ─── «Mine valg» — the anchor contract (eierportal testrunde 1, T5) ─────────
// «Lagres der du står», step 1 (server side): every answer of a «Mine valg»
// POST is a 303 back to the page WITH an anchor, so the browser lands where
// the owner was, and the message stands in the card or row concerned (never
// in the top card). Shared by the RFB routes (routes/owner-features.ts) and
// the gårdssalg routes (routes/gardssalg-owner-features.ts) and by the page
// (page.ts), so the ids the page renders and the anchors the routes send are
// one list:
//
//   level card            #niva            (confirm a level → ?endret=<n>#niva)
//   level preview         #niva-forhandsvis, inside #niva (GET ?niva=<level>)
//   switch row            #valg-<key>      (its confirm panel inside li#valg-<key>)
//   news question         #gruppe-comms    (the row: #valg-comms.news)
//   planned item          #planlagt-<key>  (the planned box: #planlagt)
//   change log            #endringslogg
//   undo                  the row or card that was undone
//   no row known          #mv-toast-slot   (the message slot at the bottom)
//
// The fragment never reaches the server, so a message redirect also carries
// the element id as `ved=<id>`; a saved change (`?endret=<batch>`) is placed
// from the batch itself (ownerBatchAnchor), which keeps the contract's
// `?endret=<n>#niva` / `#valg-<key>` URLs as they are.

import { getDb } from "../database/init";
import { batchKeys, getOwnerChangeBatch, type OwnerChangeBatch } from "./changes";

export const OWNER_ANCHOR_LEVEL = "niva";
export const OWNER_ANCHOR_LEVEL_PREVIEW = "niva-forhandsvis";
export const OWNER_ANCHOR_NEWS_QUESTION = "gruppe-comms";
export const OWNER_ANCHOR_PLANNED = "planlagt";
export const OWNER_ANCHOR_LOG = "endringslogg";
/** The message slot at the bottom of the page (when no row or card is known). */
export const OWNER_ANCHOR_FALLBACK = "mv-toast-slot";

/** The row of one entry: li#valg-<key>. */
export function ownerRowAnchor(key: string): string {
  return `valg-${key}`;
}

/** One planned (coming_soon) item: li#planlagt-<key>. */
export function ownerPlannedAnchor(key: string): string {
  return `planlagt-${key}`;
}

/**
 * The element ids a message may be placed at (`ved=`). Anything else — a
 * hand-edited query — is ignored and the message goes to the fallback slot.
 */
export function isOwnerPageAnchor(id: unknown): id is string {
  return typeof id === "string" && id.length <= 120 &&
    /^(niva|planlagt|endringslogg|gruppe-[a-z_]+|valg-[a-z0-9_.-]+|planlagt-[a-z0-9_.-]+)$/i.test(id);
}

/**
 * The page tail for a 303: `?<query>&ved=<anchor>#<anchor>` (a message placed
 * at the anchor) or, with `place: false`, `?<query>#<anchor>` (the query
 * itself says where: ?endret=, ?bekreft=, ?niva=).
 */
export function ownerPageTail(query: string, anchor: string, opts: { place?: boolean } = {}): string {
  const q = query.replace(/^\?/, "");
  const place = opts.place !== false && anchor !== OWNER_ANCHOR_FALLBACK;
  const parts = [q, place ? `ved=${encodeURIComponent(anchor)}` : ""].filter(Boolean).join("&");
  return `${parts ? `?${parts}` : ""}#${anchorFragment(anchor)}`;
}

/** The fragment for an anchor (keys are [a-z0-9._-]; anything else is encoded). */
function anchorFragment(anchor: string): string {
  return anchor.split("").map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : encodeURIComponent(c))).join("");
}

/** Where a batch's change is shown: a level → #niva, one key → its row. */
function anchorOfBatch(batch: OwnerChangeBatch, db: any): string {
  if (batch.kind === "level") return OWNER_ANCHOR_LEVEL;
  const keys = batchKeys(batch, db);
  if (keys.length === 1) return ownerRowAnchor(keys[0]);
  return OWNER_ANCHOR_FALLBACK;
}

/**
 * The anchor of a saved change (`?endret=<batch>`): a level batch → the
 * level card, a single change → its row, an undo → the row or card it
 * undid. null = no such batch for this subject.
 */
export function ownerBatchAnchor(vertical: string, subjectId: string, batchId: number, db: any = getDb()): string | null {
  const batch = getOwnerChangeBatch(vertical, subjectId, batchId, db);
  if (!batch) return null;
  if (batch.kind !== "undo") return anchorOfBatch(batch, db);
  const undone = db
    .prepare(`SELECT * FROM owner_feature_change_batch WHERE vertical = ? AND subject_id = ? AND undone_by_batch = ?`)
    .get(vertical, subjectId, batchId) as OwnerChangeBatch | undefined;
  return undone ? anchorOfBatch(undone, db) : anchorOfBatch(batch, db);
}

/** The anchor «Angre» returns to for batch `batchId` (before it is undone); unknown → the change log. */
export function ownerUndoAnchor(vertical: string, subjectId: string, batchId: number, db: any = getDb()): string {
  if (!Number.isFinite(batchId) || batchId <= 0) return OWNER_ANCHOR_LOG;
  return ownerBatchAnchor(vertical, subjectId, batchId, db) ?? OWNER_ANCHOR_LOG;
}
