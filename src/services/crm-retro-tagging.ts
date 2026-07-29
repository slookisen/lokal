// ─── Retro-tagging the mis-filed history ────────────────────────────
//
// dev-requests/2026-07-27-crm-plattformadskillelse-opplevagent.md, steg 5:
//
//   «Alt i CRM-en er 'rfb' i dag, inkludert reelle opplevagent-henvendelser.
//    • Dry-run default, rapporterer hvilke rader den mener er opplevagent og på
//      hvilket grunnlag, før noe skrives.
//    • Apply krever Daniels godkjenning av tallet.
//    • Audit + reverserbart per rad/batch. ALDRI en blind UPDATE på historikk.»
//
// Measured against live prod 2026-07-29: 799 contacts and ~1419 threads, every
// one of them 'rfb'; experiences and dental are empty. So the mixing is not a
// risk to be prevented here — it already happened, and this is the cleanup.
//
// ── THE RULE: EVIDENCE, NOT INFERENCE ───────────────────────────────
//
// The tempting design is a classifier: look at the subject, the body, the
// sender's domain, and decide. That is the same mistake as putting the live
// triage in the agent's prompt, with one aggravating difference — this writes to
// HISTORY, where nobody will re-read the mail to check. A wrong retro-tag is
// indistinguishable from a correct one forever after.
//
// So a row is only ever re-tagged on DOCUMENTARY evidence: something the system
// itself recorded at the time, which happens to survive in a column nobody was
// reading. Two such sources exist, and they are ranked because they differ in
// strength, not in convenience:
//
//   TIER A — the contact form recorded the platform.
//     routes/contact.ts writes crm_actions.payload = {source:"kontaktskjema",
//     platform:"experiences", …} and THEN the row was filed 'rfb' by the column
//     default. The platform was known at submission time and thrown away one
//     table over. This is not inference at all; it is reading back what we
//     already wrote down.
//
//   TIER B — a recipient header names the opplevagent alias.
//     crm_messages.to_emails / cc_emails / raw_metadata carry the addresses the
//     mail actually went to. Decided by the SAME function the live path uses
//     (crm-triage.deriveVertical), deliberately: if retro-tagging and live
//     routing could disagree, retro-tagging would create threads the live path
//     would later refuse with the B4 409. They agree by construction.
//
// Everything else is UNDECIDABLE and stays 'rfb'. Not "probably rfb" — it stays
// where it is because there is no evidence to move it, and the report says so
// with a count. An honest "I could not tell for 1,412 of 1,419" is the useful
// answer; a confident re-tag of all of them is not.
//
// ── WHY MOVING A THREAD IS NOT ONE UPDATE ───────────────────────────
//
// Steg 2 made contacts unique per (email, vertical_id), so a thread cannot just
// change its own vertical_id — it would keep pointing at the RFB contact row and
// end up half one platform, half the other. That is exactly the split review B4
// found and refused on the live path. Moving a thread therefore means:
//
//   1. find-or-create the contact for (email, target vertical)
//   2. repoint the thread at it AND stamp the thread
//   3. stamp every message on the thread
//
// all in ONE transaction, with the before-state recorded first.

import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { CrmVertical, assertVertical, crmService } from "./crm-service";
import { deriveVertical, RoutingSignals } from "./crm-triage";

export type EvidenceTier = "A_form_recorded_platform" | "B_recipient_header";

export interface RetroCandidate {
  threadId: string;
  contactId: string;
  contactEmail: string;
  currentVertical: string;
  proposedVertical: CrmVertical;
  tier: EvidenceTier;
  /** Verbatim, quotable, and specific enough for Daniel to spot-check by hand. */
  evidence: string;
  messageCount: number;
  subject: string | null;
}

export interface RetroPlan {
  generatedAt: string;
  scanned: number;
  candidates: RetroCandidate[];
  byTier: Record<string, number>;
  byProposedVertical: Record<string, number>;
  /** Rows with no documentary evidence. They stay put. */
  undecidable: number;
  /**
   * Identity of this exact plan. `apply` must quote it back, so an apply can
   * never land on a plan Daniel did not read — see applyRetroTagging.
   */
  planFingerprint: string;
}

/**
 * A stable fingerprint over the DECISIONS, not the wall clock. Two scans of an
 * unchanged database produce the same fingerprint, so Daniel can read a plan,
 * think about it, and approve it later. It changes the moment any thread's
 * proposed vertical or evidence tier changes — which is precisely when the
 * approval he gave no longer describes what would happen.
 */
function fingerprint(candidates: RetroCandidate[]): string {
  const canonical = candidates
    .map((c) => `${c.threadId}:${c.proposedVertical}:${c.tier}`)
    .sort()
    .join("|");
  // djb2 — no crypto needed; this detects change, it does not defend against a
  // forger, and both facts are worth being explicit about.
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) h = ((h << 5) + h + canonical.charCodeAt(i)) | 0;
  return `${candidates.length}-${(h >>> 0).toString(16)}`;
}

function parseJsonArray(s: unknown): string[] {
  if (typeof s !== "string" || s.trim() === "") return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Tier A: the contact form wrote the platform down and we filed it as rfb anyway. */
function tierAEvidence(db: any, threadId: string): { vertical: CrmVertical; evidence: string } | null {
  const rows = db
    .prepare(
      `SELECT payload, created_at FROM crm_actions
        WHERE thread_id = ? AND type = 'imported'
        ORDER BY created_at`,
    )
    .all(threadId) as Array<{ payload: string; created_at: string }>;

  for (const r of rows) {
    let p: any;
    try {
      p = JSON.parse(r.payload || "{}");
    } catch {
      continue;
    }
    if (p?.source !== "kontaktskjema") continue;
    const platform = typeof p.platform === "string" ? p.platform.trim().toLowerCase() : "";
    if (platform === "") continue;
    // Only a valid vertical counts. An unknown-but-present platform is exactly
    // the fail-open case steg 4 closed on the live route; it must not become a
    // guess here either.
    try {
      const v = assertVertical(platform, "retro:tierA");
      return {
        vertical: v,
        evidence:
          `contact form recorded platform=${JSON.stringify(platform)} in crm_actions ` +
          `(type=imported, source=kontaktskjema, ${r.created_at}) — the platform was known at ` +
          `submission time and the row was filed 'rfb' by the column default`,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Tier B: the recipient headers on this thread's messages name a platform alias. */
function tierBEvidence(db: any, threadId: string): { vertical: CrmVertical; evidence: string } | null {
  const msgs = db
    .prepare(
      `SELECT id, to_emails, cc_emails, raw_metadata FROM crm_messages
        WHERE thread_id = ? ORDER BY rowid`,
    )
    .all(threadId) as Array<{ id: string; to_emails: string; cc_emails: string; raw_metadata: string }>;

  for (const m of msgs) {
    const signals: RoutingSignals = {
      to: parseJsonArray(m.to_emails),
      cc: parseJsonArray(m.cc_emails),
    };
    // raw_metadata may carry the real headers on CS-ingested threads.
    try {
      const raw = JSON.parse(m.raw_metadata || "{}");
      if (raw && typeof raw === "object") {
        for (const k of ["deliveredTo", "delivered_to", "xForwardedTo", "envelopeTo"] as const) {
          const v = (raw as any)[k];
          if (typeof v === "string" || Array.isArray(v)) (signals as any).deliveredTo = v;
        }
      }
    } catch {
      /* malformed metadata is simply no signal */
    }

    const outcome = deriveVertical(signals);
    if (outcome.routed) {
      return {
        vertical: outcome.vertical,
        evidence:
          `message ${m.id} names ${outcome.matchedAddress} in ${outcome.matchedIn} — decided by the ` +
          `SAME crm-triage.deriveVertical the live ingest path uses, so this re-tag cannot disagree ` +
          `with what live routing would do for the same headers`,
      };
    }
  }
  return null;
}

/**
 * Build the plan. READ-ONLY — this function writes nothing, and is the only
 * thing the default (dry-run) path ever calls.
 */
export function planRetroTagging(opts: { limit?: number } = {}): RetroPlan {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 5000, 1), 20000);

  const threads = db
    .prepare(
      `SELECT t.id, t.contact_id, t.vertical_id, t.subject, c.email AS contact_email,
              (SELECT COUNT(*) FROM crm_messages m WHERE m.thread_id = t.id) AS message_count
         FROM crm_threads t
         JOIN crm_contacts c ON c.id = t.contact_id
        ORDER BY t.rowid
        LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    contact_id: string;
    vertical_id: string;
    subject: string | null;
    contact_email: string;
    message_count: number;
  }>;

  const candidates: RetroCandidate[] = [];
  let undecidable = 0;

  for (const t of threads) {
    // Tier A first: a recorded platform beats a header, because the form knew
    // the platform directly while a header is us reading a routing artefact.
    //
    // The tier is carried out of the lookup rather than re-derived from it. An
    // earlier version called tierAEvidence twice — once for the value, once to
    // decide the label — which is two chances for them to disagree about the
    // same row for no benefit.
    const a = tierAEvidence(db, t.id);
    const hit = a ?? tierBEvidence(db, t.id);
    const tier: EvidenceTier | null = hit ? (a ? "A_form_recorded_platform" : "B_recipient_header") : null;

    if (!hit || !tier) {
      undecidable++;
      continue;
    }
    // Already correct — not a candidate, and not undecidable either.
    if (hit.vertical === t.vertical_id) continue;

    candidates.push({
      threadId: t.id,
      contactId: t.contact_id,
      contactEmail: t.contact_email,
      currentVertical: t.vertical_id,
      proposedVertical: hit.vertical,
      tier,
      evidence: hit.evidence,
      messageCount: t.message_count,
      subject: t.subject,
    });
  }

  const byTier: Record<string, number> = {};
  const byProposedVertical: Record<string, number> = {};
  for (const c of candidates) {
    byTier[c.tier] = (byTier[c.tier] ?? 0) + 1;
    byProposedVertical[c.proposedVertical] = (byProposedVertical[c.proposedVertical] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    scanned: threads.length,
    candidates,
    byTier,
    byProposedVertical,
    undecidable,
    planFingerprint: fingerprint(candidates),
  };
}

export interface ApplyResult {
  batchId: string;
  applied: number;
  threads: Array<{ threadId: string; from: string; to: CrmVertical; newContactId: string }>;
}

/**
 * Apply a plan. Refuses unless the caller quotes back the fingerprint AND the
 * count of the plan they read.
 *
 * This is the «Daniels godkjenning av tallet» gate, and it is a real gate rather
 * than a ceremony: the fingerprint covers every (thread, target, tier) triple,
 * so if anything changed between reading and approving — a new thread arrived, a
 * header was re-ingested, evidence appeared — the apply refuses instead of
 * doing something Daniel never saw. Approving "17 rows" cannot silently become
 * 18.
 */
export function applyRetroTagging(opts: {
  approvedFingerprint: string;
  approvedCount: number;
  approvedBy: string;
  limit?: number;
}): ApplyResult {
  const db = getDb();
  const plan = planRetroTagging({ limit: opts.limit });

  if (plan.planFingerprint !== opts.approvedFingerprint) {
    throw new Error(
      `[retro] plan changed since it was approved — approved ${JSON.stringify(opts.approvedFingerprint)}, ` +
        `current ${JSON.stringify(plan.planFingerprint)}. Re-read the dry-run and approve the new plan. ` +
        `Refusing to apply a plan nobody has seen.`,
    );
  }
  if (plan.candidates.length !== opts.approvedCount) {
    throw new Error(
      `[retro] approved count ${opts.approvedCount} does not match the plan's ${plan.candidates.length}. ` +
        `Refusing — the number IS the approval.`,
    );
  }

  const batchId = randomUUID();
  const applied: ApplyResult["threads"] = [];

  const run = db.transaction(() => {
    for (const c of plan.candidates) {
      // 1. The contact on the TARGET platform. resolveContact is find-or-create
      //    and is the same call the live path makes, so the (email, vertical)
      //    uniqueness from steg 2 is respected rather than worked around.
      const target = crmService.resolveContact(c.contactEmail, null, c.proposedVertical);

      // 2. Record the BEFORE state before touching anything. An audit row
      //    written after the update can only describe what it hopes happened.
      db.prepare(
        `INSERT INTO crm_retro_tagging_audit
           (id, batch_id, thread_id, from_vertical, to_vertical, from_contact_id, to_contact_id,
            tier, evidence, message_ids, applied_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        batchId,
        c.threadId,
        c.currentVertical,
        c.proposedVertical,
        c.contactId,
        target.id,
        c.tier,
        c.evidence,
        JSON.stringify(
          (db.prepare("SELECT id FROM crm_messages WHERE thread_id = ?").all(c.threadId) as Array<{ id: string }>)
            .map((m) => m.id),
        ),
        opts.approvedBy,
      );

      // 3. Move the thread AND its messages together. Doing one without the
      //    other is the half-one-platform split review B4 refused on the live
      //    path; the transaction makes the pair atomic rather than merely
      //    adjacent.
      db.prepare("UPDATE crm_threads SET contact_id = ?, vertical_id = ? WHERE id = ?")
        .run(target.id, c.proposedVertical, c.threadId);
      db.prepare("UPDATE crm_messages SET vertical_id = ? WHERE thread_id = ?")
        .run(c.proposedVertical, c.threadId);

      applied.push({ threadId: c.threadId, from: c.currentVertical, to: c.proposedVertical, newContactId: target.id });
    }
  });
  run();

  return { batchId, applied: applied.length, threads: applied };
}

/**
 * Undo a batch, exactly. Reads the audit rows and puts each thread back where it
 * was — including its original contact_id, which a vertical-only revert would
 * leave pointing at the wrong platform's contact.
 *
 * Reversibility is a property of the audit table, not of a comment claiming it.
 */
export function revertRetroTaggingBatch(batchId: string): { reverted: number } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT thread_id, from_vertical, to_vertical, from_contact_id, reverted_at
         FROM crm_retro_tagging_audit WHERE batch_id = ?`,
    )
    .all(batchId) as Array<{
    thread_id: string;
    from_vertical: string;
    to_vertical: string;
    from_contact_id: string;
    reverted_at: string | null;
  }>;

  if (rows.length === 0) throw new Error(`[retro] no audit rows for batch ${JSON.stringify(batchId)}`);

  let reverted = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      if (r.reverted_at) continue; // already undone; idempotent
      db.prepare("UPDATE crm_threads SET contact_id = ?, vertical_id = ? WHERE id = ?")
        .run(r.from_contact_id, r.from_vertical, r.thread_id);
      db.prepare("UPDATE crm_messages SET vertical_id = ? WHERE thread_id = ?")
        .run(r.from_vertical, r.thread_id);
      db.prepare("UPDATE crm_retro_tagging_audit SET reverted_at = datetime('now') WHERE batch_id = ? AND thread_id = ?")
        .run(batchId, r.thread_id);
      reverted++;
    }
  });
  run();

  return { reverted };
}

export function listRetroBatches(): Array<{
  batch_id: string;
  applied_at: string;
  rows: number;
  reverted_rows: number;
  applied_by: string;
}> {
  return getDb()
    .prepare(
      `SELECT batch_id,
              MIN(applied_at) AS applied_at,
              COUNT(*) AS rows,
              SUM(CASE WHEN reverted_at IS NOT NULL THEN 1 ELSE 0 END) AS reverted_rows,
              MIN(applied_by) AS applied_by
         FROM crm_retro_tagging_audit
        GROUP BY batch_id
        ORDER BY MIN(applied_at) DESC`,
    )
    .all() as any[];
}
