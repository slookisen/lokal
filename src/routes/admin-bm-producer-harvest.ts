// ─── Admin: Bondens Marked producer harvest (dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 2) ──
//
// GET /admin/bm-producer-harvest
//
//   READ-ONLY / DRY-RUN ONLY diagnostic. Fetches bondensmarked.no's
//   ~345 producer pages (via services/bm-producer-harvest.ts), fuzzy-matches
//   each parsed record against our own `agents` catalog, and reports what a
//   future "apply" slice WOULD write — without writing anything.
//
//   Query params:
//     limit    — optional positive integer, default = process all slugs,
//                hard-capped at 400 regardless of what's requested.
//     dry_run  — optional, default "true". The literal string "false" is
//                the ONLY way to reach the apply-mode stub below.
//
// GET /admin/bm-producer-harvest?dry_run=false
//
//   APPLY MODE (dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 3).
//   Re-runs the same fetch/match loop as the dry-run branch above, for the
//   apply-mode slug window (default 20, hard max now HARD_CAP_SLUGS/400 —
//   same ceiling as the dry-run cap, since slice 6 removed the old
//   deliberately-lower 50 cap; the DEFAULT of 20 is still far below both),
//   and writes `agents.contact_email` from the
//   harvested BM record's email for exactly the rows that pass the same
//   claimed/curated/validation gates as
//   POST /admin/agents/contact-email-write (admin-agents-contact-email-write.ts,
//   the canonical write-discipline reference for this column).
//
//   Slice 4 (dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 4) extends
//   the SAME apply-mode loop to ALSO attempt writing `record.phone` into
//   `agent_knowledge.phone` for the same matched row, in the same batch/call,
//   under the SAME shared `limit`. Reuses `validatePhoneForWrite`/
//   `normalizePhone` (services/contact-normalizer.ts) for the write-time
//   phone-shape/org-nr-collision/date-shape guard, and a new local
//   `isContactPhoneCurated` helper (mirrors `isContactEmailCurated`'s shape,
//   checking `curated_fields`'s "phone" key) for the field-lock. A row can
//   write email, phone, both, or neither — the two write types are
//   independent outcomes on the same result row.
//
//   Slice 5 (dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 5) extends
//   the SAME apply-mode loop a THIRD time to attempt a URL candidate for the
//   same matched row — but url-write is QUEUE ONLY, never a direct write
//   (stronger discipline than email/phone, per the fleet's binding "review-kø,
//   aldri auto-skriv" website-candidate norm). For a matched row whose
//   `record.website` is non-null AND whose agent_knowledge.website is
//   currently blank, this file calls the SAME evidence-gated evaluation
//   admin-rfb-website-discovery.ts's own external-candidate intake uses
//   (`evaluateRfbWebsiteCandidate`, exported there — imported here, never
//   duplicated) with one shared existingHosts/hostsProposedThisBatch/
//   fallbackCounters accumulator threaded across the WHOLE apply-mode call
//   (not per-row), same shared-host-dedup guarantee that route's own
//   multi-candidate call gives itself. The ONLY side effect a url candidate
//   can ever cause is a row in `agents_website_review_queue` (via that same
//   module's `upsertRfbWebsiteReviewQueue`) — this file NEVER writes
//   `agent_knowledge.website` for a url candidate, and never calls
//   `applyRfbAgentWebsite` / the review-approve route (explicitly out of
//   scope — a human reviewer's lever, not this harvest route's).
//
// Auth: X-Admin-Key (same pattern as admin-bm-reconcile.ts — own local
// requireAdmin, no shared middleware, per this codebase's convention).
//
// The dry_run branch below performs ZERO database writes — no
// INSERT/UPDATE/DELETE/.run( at all — exactly as before slice 3. The apply
// branch is the only place in this file that writes, and only to
// agents.contact_email, agent_knowledge.phone (+ an `INSERT OR IGNORE INTO
// agent_knowledge` row-creation step when no row exists yet for a matched
// agent), `agents_website_review_queue` (via evaluateRfbWebsiteCandidate,
// slice 5 — queue only, never agent_knowledge.website itself), + one
// agent_knowledge_audit row per email/phone change (url candidates write no
// audit row — the queue insert/upsert IS their only, fully reversible,
// effect, same guarantee admin-rfb-website-discovery.ts's own callers get).

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import {
  fetchBmProducerSlugs,
  fetchBmProducerRecord,
  matchBmProducerToCatalog,
} from "../services/bm-producer-harvest";
import {
  isSyntacticallyValidEmail,
  isPlatformOwnedEmailDomain,
  isContactEmailCurated,
} from "./admin-agents-contact-email-write";
import { validatePhoneForWrite, normalizePhone } from "../services/contact-normalizer";
// Slice 5: url-write via the SAME evidence-gated evaluation
// admin-rfb-website-discovery.ts's own external-candidate intake uses —
// imported, never duplicated (ground rule "export, don't duplicate").
// `ensureRfbWebsiteReviewQueueTable`/`rfbWdExistingWebsiteHosts` are the
// small pieces of that route's own per-call setup this file needs to
// reproduce (table-exists guarantee + the shared existingHosts snapshot);
// `evaluateRfbWebsiteCandidate` and its RfbWdFallbackCounters param type are
// the reused evidence-gating logic itself.
import {
  evaluateRfbWebsiteCandidate,
  ensureRfbWebsiteReviewQueueTable,
  rfbWdExistingWebsiteHosts,
  RfbWdFallbackCounters,
} from "./admin-rfb-website-discovery";

const router = Router();

// ─── Auth helper (same pattern as admin-bm-reconcile.ts) ──────────────────

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

const HARD_CAP_SLUGS = 400;

// ─── Apply-mode (slice 3) ───────────────────────────────────────────────────

/** Default (20) stays deliberately far below HARD_CAP_SLUGS (400) — apply mode WRITES, dry-run only reads. */
const APPLY_DEFAULT_LIMIT = 20;
const APPLY_MAX_LIMIT = HARD_CAP_SLUGS; // was: 50 — see dev-request 2026-08-14-bm-fullhoest-katalogbred Slice 6: a monthly apply run must cover the whole catalog, not just the first 50 slugs (no offset/cursor exists). Now EQUALS the dry-run cap (400), no longer "far below" it — see APPLY_TIME_BUDGET_MS below for the wall-clock safety valve this raise requires.

// Wall-clock safety valve for the apply-mode loop (code-review finding on
// this same PR: raising APPLY_MAX_LIMIT to 400 raises the theoretical
// worst-case sequential runtime — each matched slug with an eligible url
// candidate can trigger a live outbound fetch via evaluateRfbWebsiteCandidate
// (~10-25s per slow/dead host) — from ~21 minutes to ~2.8 hours, with
// nothing bounding it). Mirrors the RFB_WD_TIME_BUDGET_MS /
// time_budget_exceeded / skipped_due_to_time_budget convention
// admin-rfb-website-discovery.ts already established for this exact same
// class of problem — same field names, same "stop starting new work, don't
// abort work already in flight" semantics. 60s is generous for this route's
// DB-only per-row cost (dry-run's own ~400-slug/no-fetch runs are far
// faster) but well short of typical HTTP gateway/proxy timeouts.
export const APPLY_TIME_BUDGET_MS = 60_000;

// Test-only injection point for the wall-clock used by the time-budget check
// below (mirrors __setRfbWdNowForTesting, admin-rfb-website-discovery.ts):
// production code always leaves this null and gets the real Date.now() — a
// test installs a deterministic override so budget-exceeded behavior can be
// exercised without actually waiting APPLY_TIME_BUDGET_MS of real wall-clock
// time.
let bmHarvestNowForTesting: (() => number) | null = null;
export function __setBmHarvestNowForTesting(fn: (() => number) | null): void {
  bmHarvestNowForTesting = fn;
}
function effectiveBmHarvestNowMs(): number {
  return bmHarvestNowForTesting ? bmHarvestNowForTesting() : Date.now();
}

/**
 * Defense-in-depth: bm-producer-harvest.ts's own parser already excludes
 * @bondensmarked.no mailtos from `record.email` (bmDomainEmailExcluded), but
 * this route re-checks independently, in its OWN code, before any write
 * attempt — never trust a single upstream filter to guard a write path.
 * Mirrors isBmDomainEmail in services/bm-producer-harvest.ts (not exported,
 * so re-declared here rather than imported).
 */
function isBmDomainEmailForApply(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  return domain === "bondensmarked.no" || domain.endsWith(".bondensmarked.no");
}

type ApplyOutcome =
  | "written"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "skipped_bm_domain"
  | "skipped_no_email"
  | "rejected_invalid_email"
  | "rejected_platform_domain"
  | "unmatched"
  | "parse_failed"
  | "error";

// ─── Phone outcomes (slice 4) ───────────────────────────────────────────────
// Additive, own vocabulary — email's existing outcomes above keep their own
// unprefixed names unchanged. A row can carry BOTH an `outcome` (email) and a
// `phone_outcome` (phone) — they are independent per-field results on the
// same matched row. "error" is intentionally shared/unprefixed with
// ApplyOutcome's own "error" (same generic meaning: something unexpected,
// not one of the specific named rejects/skips).
type PhoneOutcome =
  | "phone_written"
  | "phone_skipped_claimed"
  | "phone_skipped_curated"
  | "phone_skipped_unchanged"
  | "phone_rejected_invalid";

// ─── URL outcomes (slice 5, QUEUE ONLY — see file header) ──────────────────
// Additive, own vocabulary, same independent-per-field-outcome convention
// slice 4 established for phone. Deliberately NO "url_written" value exists
// (per the file header's safety framing) — the only "success" outcome is
// `url_proposed`, meaning a row landed in agents_website_review_queue, never
// agent_knowledge.website. `url_rejected_${reason}` reuses
// evaluateRfbWebsiteCandidate's own `rejected.reason` vocabulary verbatim
// (e.g. "host_already_proposed_this_batch", "no_candidate_verified") so a
// caller never has to translate between this route's outcome names and that
// function's — `url_already_has_website` is the (rare, race-only) path where
// evaluateRfbWebsiteCandidate's OWN fresh read disagrees with this route's
// own pre-check; `url_skip_no_candidate` is this route's own pre-check
// short-circuit, covering BOTH "record.website is null" (AC5: zero calls
// into evaluateRfbWebsiteCandidate) AND "agent_knowledge.website is already
// non-blank" — the row is simply not eligible, distinct from an
// evaluated-and-rejected candidate.
type UrlOutcome = "url_proposed" | `url_rejected_${string}` | "url_already_has_website" | "url_skip_no_candidate";

interface ApplyResultItem {
  slug: string;
  agent_id?: string;
  outcome: ApplyOutcome;
  old_value?: string | null;
  new_value?: string | null;
  detail?: string;
  phone_outcome?: PhoneOutcome | "error";
  phone_old_value?: string | null;
  phone_new_value?: string | null;
  phone_detail?: string;
  url_outcome?: UrlOutcome;
  url_new_value?: string;
  url_final_url?: string;
  url_detail?: string;
}

/**
 * True iff the parsed curated_fields JSON locks the phone field. Structurally
 * identical to isContactEmailCurated (admin-agents-contact-email-write.ts) —
 * same column (`agent_knowledge.curated_fields`), same lock semantics, new
 * key ("phone" — the agent_knowledge column name; unlike email there is no
 * second historical spelling to also accept). Tolerates malformed/missing
 * JSON (treated as "not locked"), same defensive-parse convention.
 */
function isContactPhoneCurated(curatedFieldsJson: string | null | undefined): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    const o = parsed as Record<string, unknown>;
    return !!o["phone"];
  } catch {
    return false;
  }
}

/**
 * Write ONE agent's contact_email from its matched BM record. Modeled
 * structurally on applyContactEmail() in admin-agents-contact-email-write.ts:
 * re-reads claimed_at + curated_fields + the current value from a FRESH
 * snapshot immediately before writing, inside its own transaction, and
 * writes one agent_knowledge_audit row carrying the OLD value on success.
 * One row per transaction — a failure here must never abort the batch, so
 * every path through this function returns rather than throws (the try/catch
 * is a final backstop for anything unexpected from better-sqlite3 itself).
 */
function applyBmEmail(
  db: ReturnType<typeof getDb>,
  agentId: string,
  newValue: string,
  batchTag: string,
  slug: string,
): { outcome: ApplyOutcome; oldValue?: string | null; detail?: string } {
  try {
    const tx = db.transaction((): { outcome: ApplyOutcome; oldValue?: string | null; detail?: string } => {
      const cur = db
        .prepare(
          `SELECT a.claimed_at AS claimed_at,
                  a.contact_email AS contact_email,
                  k.curated_fields AS curated_fields
             FROM agents a
             LEFT JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`,
        )
        .get(agentId) as
        | { claimed_at: string | null; contact_email: string | null; curated_fields: string | null }
        | undefined;

      if (!cur) return { outcome: "error", detail: "agent not found at write time" };
      if (cur.claimed_at) return { outcome: "skipped_claimed" };
      if (isContactEmailCurated(cur.curated_fields)) return { outcome: "skipped_curated" };

      const currentValue = cur.contact_email ?? "";
      if (currentValue.trim().toLowerCase() === newValue.trim().toLowerCase()) {
        return { outcome: "skipped_unchanged", oldValue: cur.contact_email };
      }

      db.prepare(`UPDATE agents SET contact_email = ? WHERE id = ?`).run(newValue, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'contact_email', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.contact_email, newValue, `${batchTag}: slug=${slug}`);

      return { outcome: "written", oldValue: currentValue };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

/**
 * Write ONE agent's agent_knowledge.phone from its matched BM record's
 * already-validated (validatePhoneForWrite) phone value. Same structural
 * discipline as applyBmEmail: re-reads claimed_at + curated_fields + the
 * current phone value from a FRESH snapshot immediately before writing,
 * inside its own transaction, and writes one agent_knowledge_audit row on
 * success carrying the OLD value (NULL/empty if the row was just created).
 *
 * `agent_knowledge` may not have a row at all yet for a newly-matched
 * producer — `INSERT OR IGNORE INTO agent_knowledge (agent_id) VALUES (?)`
 * is fired unconditionally right before the fresh read; OR IGNORE makes it a
 * true no-op (touches nothing) when a row already exists, so an existing
 * row's other columns are never touched by this step (mirrors PR#574's
 * ensureKnowledgeRowForExternalCandidate one-liner shape — module-private in
 * its own file, so re-declared locally here rather than imported, per the
 * slice 4 spec).
 *
 * `newValue` is assumed already shape/org-nr/date validated by the caller
 * (validatePhoneForWrite) — this function does not re-validate the value
 * itself, only the claimed/curated/unchanged write-time state, exactly like
 * applyBmEmail does for email.
 */
function applyBmPhone(
  db: ReturnType<typeof getDb>,
  agentId: string,
  newValue: string,
  batchTag: string,
  slug: string,
): { outcome: PhoneOutcome | "error"; oldValue?: string | null; detail?: string } {
  try {
    const tx = db.transaction((): { outcome: PhoneOutcome | "error"; oldValue?: string | null; detail?: string } => {
      db.prepare(`INSERT OR IGNORE INTO agent_knowledge (agent_id) VALUES (?)`).run(agentId);

      const cur = db
        .prepare(
          `SELECT a.claimed_at AS claimed_at,
                  k.phone AS phone,
                  k.curated_fields AS curated_fields
             FROM agents a
             LEFT JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`,
        )
        .get(agentId) as
        | { claimed_at: string | null; phone: string | null; curated_fields: string | null }
        | undefined;

      if (!cur) return { outcome: "error", detail: "agent not found at write time" };
      if (cur.claimed_at) return { outcome: "phone_skipped_claimed" };
      if (isContactPhoneCurated(cur.curated_fields)) return { outcome: "phone_skipped_curated" };

      if (cur.phone && normalizePhone(cur.phone) === normalizePhone(newValue)) {
        return { outcome: "phone_skipped_unchanged", oldValue: cur.phone };
      }

      db.prepare(`UPDATE agent_knowledge SET phone = ? WHERE agent_id = ?`).run(newValue, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'phone', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.phone, newValue, `${batchTag}: slug=${slug}`);

      return { outcome: "phone_written", oldValue: cur.phone };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

router.get("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // The ONLY way into apply-mode is the literal string "false" — missing,
  // "1", "yes", anything else stays on the safe dry-run path below.
  const dryRunParam = typeof req.query.dry_run === "string" ? req.query.dry_run : "true";
  if (dryRunParam === "false") {
    const tApply0 = effectiveBmHarvestNowMs();
    try {
      let limit = APPLY_DEFAULT_LIMIT;
      if (typeof req.query.limit === "string") {
        const n = parseInt(req.query.limit, 10);
        if (Number.isFinite(n) && n > 0) {
          limit = Math.min(n, APPLY_MAX_LIMIT);
        }
      }

      const allSlugs = await fetchBmProducerSlugs();
      const total_slugs = allSlugs.length;
      const slugsToProcess = allSlugs.slice(0, limit);

      const db = getDb();
      const batchTag = `bm-producer-harvest-${new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .slice(0, 15)}`;

      // ── URL (slice 5) shared, whole-call accumulators ────────────────────
      // Built ONCE before the slug loop (not per row) — same
      // "existingHosts/hostsProposedThisBatch/fallbackCounters threaded
      // across the WHOLE call" contract admin-rfb-website-discovery.ts's own
      // multi-candidate branch gives itself, so a shared host proposed for
      // one row in THIS call is correctly excluded for a later row in the
      // SAME call (AC6). ensureRfbWebsiteReviewQueueTable is idempotent
      // (CREATE TABLE IF NOT EXISTS) — safe to call even if the RFB
      // discovery route has never run in this process yet.
      ensureRfbWebsiteReviewQueueTable(db);
      const urlExistingHosts = rfbWdExistingWebsiteHosts(db);
      const urlHostsProposedThisBatch = new Set<string>();
      const urlFallbackCounters: RfbWdFallbackCounters = { attempted: 0, verified: 0 };

      const results: ApplyResultItem[] = [];

      // Wall-clock safety valve (see APPLY_TIME_BUDGET_MS above): checked
      // BEFORE any per-slug work starts, so it bounds total elapsed time
      // rather than just capping in-flight work. A pure safety valve — for
      // any realistic batch (or a test where slugs resolve near-instantly)
      // this never trips and changes nothing. Once tripped, no further slug
      // is started at all (not even its own fetchBmProducerRecord call) —
      // `break`, not `continue`, since every remaining requested slug is
      // uniformly skipped and there is nothing per-slug to record for them.
      let timeBudgetExceeded = false;
      for (const slug of slugsToProcess) {
        if (effectiveBmHarvestNowMs() - tApply0 > APPLY_TIME_BUDGET_MS) {
          timeBudgetExceeded = true;
          break;
        }

        const record = await fetchBmProducerRecord(slug);
        if (!record) {
          results.push({ slug, outcome: "parse_failed" });
          continue;
        }

        const match = matchBmProducerToCatalog(db, record);
        if (!match) {
          results.push({ slug, outcome: "unmatched" });
          continue;
        }
        const agentId = match.agentId;

        // ── EMAIL (slice 3) ────────────────────────────────────────────────
        // Computed into local variables rather than an early `continue` on
        // every branch (as slice 3 did) so the PHONE attempt below still
        // runs for this row regardless of the email outcome — email and
        // phone are independent write attempts on the same matched row
        // (slice 4, AC1: same call/batch/shared limit, "a row can write
        // email, phone, both, or neither"). Branch order and every
        // individual outcome/value are otherwise UNCHANGED from slice 3.
        let emailOutcome: ApplyOutcome;
        let emailOldValue: string | null | undefined;
        let emailNewValue: string | null | undefined;
        let emailDetail: string | undefined;

        // Defense-in-depth (AC2 of slice 3): hard-skip before ANY write
        // attempt — never call the write path for a bondensmarked.no address.
        // Checked BEFORE the "no email" check below because the parser sets
        // `email: null` whenever it excludes a @bondensmarked.no mailto (see
        // services/bm-producer-harvest.ts), so `bmDomainEmailExcluded` must be
        // tested on its own, independent of whether `record.email` is set —
        // relying on "email is null" to imply "was a BM address" would be
        // relying on the very upstream behavior this check exists to not
        // solely depend on.
        if (record.bmDomainEmailExcluded) {
          emailOutcome = "skipped_bm_domain";
        } else if (!record.email) {
          emailOutcome = "skipped_no_email";
        } else if (isBmDomainEmailForApply(record.email)) {
          // Second, independent form of the same defense-in-depth check: even
          // if a BM-domain email ever reached here with bmDomainEmailExcluded
          // NOT set, this route's own domain check still catches it.
          emailOutcome = "skipped_bm_domain";
        } else {
          const candidate = record.email.trim();
          if (!isSyntacticallyValidEmail(candidate)) {
            emailOutcome = "rejected_invalid_email";
            emailNewValue = candidate;
          } else if (isPlatformOwnedEmailDomain(candidate)) {
            emailOutcome = "rejected_platform_domain";
            emailNewValue = candidate;
          } else {
            const cur = db
              .prepare(
                `SELECT a.claimed_at AS claimed_at, a.contact_email AS contact_email, k.curated_fields AS curated_fields
                   FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
                  WHERE a.id = ?`,
              )
              .get(agentId) as
              | { claimed_at: string | null; contact_email: string | null; curated_fields: string | null }
              | undefined;

            if (!cur) {
              emailOutcome = "error";
              emailDetail = "matched agent not found";
            } else if (cur.claimed_at) {
              emailOutcome = "skipped_claimed";
              emailOldValue = cur.contact_email;
            } else if (isContactEmailCurated(cur.curated_fields)) {
              emailOutcome = "skipped_curated";
              emailOldValue = cur.contact_email;
            } else if ((cur.contact_email ?? "").trim().toLowerCase() === candidate.toLowerCase()) {
              emailOutcome = "skipped_unchanged";
              emailOldValue = cur.contact_email;
            } else {
              const w = applyBmEmail(db, agentId, candidate, batchTag, slug);
              emailOutcome = w.outcome;
              emailOldValue = w.oldValue ?? cur.contact_email;
              emailNewValue = candidate;
              if (w.detail) emailDetail = w.detail;
            }
          }
        }

        // ── PHONE (slice 4) ────────────────────────────────────────────────
        // Independent write attempt on the SAME matched row, same call/batch,
        // same shared `limit` (AC1) — never a second budget. Order mirrors
        // the email branch above: shape/validity rejection first
        // (validatePhoneForWrite — org-nr-collision/date-shape/8-digit-shape,
        // reused unmodified from contact-normalizer.ts), THEN row-lock
        // (claimed_at), THEN field-lock (isContactPhoneCurated), THEN
        // unchanged-value skip, THEN write. Nothing is attempted at all when
        // the harvested record carries no phone value (no outcome pushed —
        // there is nothing to gate or skip).
        let phoneOutcome: PhoneOutcome | "error" | undefined;
        let phoneOldValue: string | null | undefined;
        let phoneNewValue: string | null | undefined;
        let phoneDetail: string | undefined;

        if (record.phone) {
          const curP = db
            .prepare(
              `SELECT a.claimed_at AS claimed_at, a.org_nr AS org_nr, k.phone AS phone, k.curated_fields AS curated_fields
                 FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
                WHERE a.id = ?`,
            )
            .get(agentId) as
            | { claimed_at: string | null; org_nr: string | null; phone: string | null; curated_fields: string | null }
            | undefined;

          if (!curP) {
            phoneOutcome = "error";
            phoneDetail = "matched agent not found";
          } else {
            const validated = validatePhoneForWrite(record.phone, curP.org_nr);
            if (validated === null) {
              phoneOutcome = "phone_rejected_invalid";
              phoneNewValue = record.phone;
            } else if (curP.claimed_at) {
              phoneOutcome = "phone_skipped_claimed";
              phoneOldValue = curP.phone;
            } else if (isContactPhoneCurated(curP.curated_fields)) {
              phoneOutcome = "phone_skipped_curated";
              phoneOldValue = curP.phone;
            } else if (curP.phone && normalizePhone(curP.phone) === normalizePhone(validated)) {
              phoneOutcome = "phone_skipped_unchanged";
              phoneOldValue = curP.phone;
            } else {
              const wp = applyBmPhone(db, agentId, validated, batchTag, slug);
              phoneOutcome = wp.outcome;
              phoneOldValue = wp.oldValue ?? curP.phone;
              phoneNewValue = validated;
              if (wp.detail) phoneDetail = wp.detail;
            }
          }
        }

        // ── URL (slice 5, QUEUE ONLY) ───────────────────────────────────────
        // Independent third write-attempt on the SAME matched row, same
        // call/batch, same shared `limit` (spec AC1) — never a second
        // budget. Unlike email/phone, this NEVER writes agent_knowledge
        // directly — the only possible effect is a row in
        // agents_website_review_queue via evaluateRfbWebsiteCandidate's own
        // upsert. Pre-check (record.website present AND agent_knowledge.
        // website currently blank) happens HERE, before ever calling into
        // evaluateRfbWebsiteCandidate, so a row with no BM-sourced url — or
        // an agent that already has one — costs zero fetches (AC5's
        // "don't fetch when there's nothing to evaluate" cheapness).
        let urlOutcome: UrlOutcome | undefined;
        let urlNewValue: string | undefined;
        let urlFinalUrl: string | undefined;
        let urlDetail: string | undefined;

        if (!record.website) {
          urlOutcome = "url_skip_no_candidate";
        } else {
          const curW = db
            .prepare(`SELECT website FROM agent_knowledge WHERE agent_id = ?`)
            .get(agentId) as { website: string | null } | undefined;
          const currentWebsite = curW?.website ?? null;
          if (currentWebsite && currentWebsite.trim() !== "") {
            urlOutcome = "url_skip_no_candidate";
          } else {
            const urlResult = await evaluateRfbWebsiteCandidate(
              db,
              { agentId, url: record.website },
              urlExistingHosts,
              urlHostsProposedThisBatch,
              urlFallbackCounters,
              batchTag,
            );
            switch (urlResult.outcome) {
              case "proposed":
                urlOutcome = "url_proposed";
                urlNewValue = urlResult.candidate_url;
                urlFinalUrl = urlResult.final_url;
                break;
              case "rejected":
                urlOutcome = `url_rejected_${urlResult.reason}`;
                break;
              case "already_has_website":
                // Rare race only — this route's own pre-check above already
                // read agent_knowledge.website as blank; a distinct outcome
                // (never url_skip_no_candidate) so it's never confused with
                // this route's own pre-check short-circuit.
                urlOutcome = "url_already_has_website";
                break;
              case "not_found":
                // Should not happen: agentId is a real, just-matched agents
                // row. Surfaced as a rejected-shaped outcome rather than
                // silently dropped, same "never a throw, never a silent
                // gap" discipline the rest of this file follows.
                urlOutcome = "url_rejected_agent_not_found";
                urlDetail = "evaluateRfbWebsiteCandidate reported not_found for a matched agent";
                break;
            }
          }
        }

        results.push({
          slug,
          agent_id: agentId,
          outcome: emailOutcome,
          ...(emailOldValue !== undefined ? { old_value: emailOldValue } : {}),
          ...(emailNewValue !== undefined ? { new_value: emailNewValue } : {}),
          ...(emailDetail ? { detail: emailDetail } : {}),
          ...(phoneOutcome ? { phone_outcome: phoneOutcome } : {}),
          ...(phoneOldValue !== undefined ? { phone_old_value: phoneOldValue } : {}),
          ...(phoneNewValue !== undefined ? { phone_new_value: phoneNewValue } : {}),
          ...(phoneDetail ? { phone_detail: phoneDetail } : {}),
          ...(urlOutcome ? { url_outcome: urlOutcome } : {}),
          ...(urlNewValue !== undefined ? { url_new_value: urlNewValue } : {}),
          ...(urlFinalUrl !== undefined ? { url_final_url: urlFinalUrl } : {}),
          ...(urlDetail ? { url_detail: urlDetail } : {}),
        });
      }

      const counts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        // Additive: phone/url outcome counts land in the SAME counts object
        // (e.g. `phone_written` / `url_proposed` alongside `written`) — no
        // separate nested object, per slice 4 AC7 (extended unmodified to
        // url outcomes by slice 5).
        if (r.phone_outcome) acc[r.phone_outcome] = (acc[r.phone_outcome] ?? 0) + 1;
        if (r.url_outcome) acc[r.url_outcome] = (acc[r.url_outcome] ?? 0) + 1;
        return acc;
      }, {});

      res.json({
        success: true,
        dry_run: false,
        batch_tag: batchTag,
        total_slugs,
        // `scanned` reflects how many slugs were actually attempted before
        // the time budget (if any) cut in — NOT the full requested/capped
        // `limit`. Equals slugsToProcess.length in the (overwhelmingly
        // common) case where the budget was never hit, since results gets
        // exactly one push per attempted slug and the loop only exits early
        // via the budget `break` above.
        scanned: results.length,
        counts,
        results,
        time_budget_exceeded: timeBudgetExceeded,
        skipped_due_to_time_budget: slugsToProcess.length - results.length,
        duration_ms: effectiveBmHarvestNowMs() - tApply0,
      });
    } catch (err: any) {
      res.status(500).json({
        error: "bm-producer-harvest apply failed",
        detail: err?.message || String(err),
      });
    }
    return;
  }

  const t0 = Date.now();
  try {
    let limit = HARD_CAP_SLUGS;
    if (typeof req.query.limit === "string") {
      const n = parseInt(req.query.limit, 10);
      if (Number.isFinite(n) && n > 0) {
        limit = Math.min(n, HARD_CAP_SLUGS);
      }
    }

    const allSlugs = await fetchBmProducerSlugs();
    const total_slugs = allSlugs.length;
    const slugsToProcess = allSlugs.slice(0, limit);

    const db = getDb();

    let parse_failed = 0;
    let matched = 0;
    let unmatched = 0;
    let bm_domain_email_excluded_count = 0;
    // NOTE: address_2nd_source is a raw upper-bound estimate — it increments
    // once per matched record and does NOT apply cross-source-validator's
    // blocked_both gating. Wiring into that aggregate logic is out of scope
    // for this slice.
    const would_write_estimate = { email: 0, phone: 0, address_2nd_source: 0 };
    const sample: Array<{
      slug: string;
      bmName: string;
      agentId: string;
      agentName: string;
      nameScore: number;
    }> = [];

    for (const slug of slugsToProcess) {
      const record = await fetchBmProducerRecord(slug);
      if (!record) {
        parse_failed++;
        continue;
      }
      if (record.bmDomainEmailExcluded) bm_domain_email_excluded_count++;

      const match = matchBmProducerToCatalog(db, record);
      if (!match) {
        unmatched++;
        continue;
      }
      matched++;

      if (sample.length < 20) {
        sample.push({
          slug,
          bmName: record.name,
          agentId: match.agentId,
          agentName: match.agentName,
          nameScore: match.nameScore,
        });
      }

      // Read-only lookup of the matched agent's CURRENT contact_email/url —
      // used only to decide whether the BM-sourced value would actually
      // change anything. No write happens here or anywhere in this file.
      const agentRow = db
        .prepare("SELECT contact_email, url FROM agents WHERE id = ?")
        .get(match.agentId) as { contact_email: string | null; url: string | null } | undefined;

      if (record.email) {
        const current = (agentRow?.contact_email ?? "").trim();
        if (!current || current.toLowerCase() !== record.email.trim().toLowerCase()) {
          would_write_estimate.email++;
        }
      }
      // `agents` carries no phone column of its own (phone lives on
      // agent_knowledge, a second table deliberately left untouched by this
      // single-table read) — so from what we selected here "current" is
      // always absent, and any BM-sourced phone counts as a would-be fill.
      if (record.phone) {
        would_write_estimate.phone++;
      }
      would_write_estimate.address_2nd_source++;
    }

    res.json({
      total_slugs,
      fetched: slugsToProcess.length,
      parse_failed,
      matched,
      unmatched,
      would_write_estimate,
      bm_domain_email_excluded_count,
      sample,
      duration_ms: Date.now() - t0,
    });
  } catch (err: any) {
    res.status(500).json({
      error: "bm-producer-harvest failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;
