// ─── Gårdssalg producer <-> experience/activity conflict diagnosis + remediation ─
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 2 of 5.
//
// Gårdssalg (farm-shop) producers live in `experience_providers` as their own
// profile pages. Separately, the `experiences` catalog ("opplevelser") can
// independently contain a row describing the SAME real-world business,
// harvested from a different source, with its own (sometimes wrong)
// `booking_url`. These are two different entity TYPES in two different
// TABLES that nobody has cross-checked against each other. Confirmed concrete
// case (dev-request Funn 2): producer `atlungstad-brenneri--bbe4185d`
// (hjemmeside `atlungstadbrenneri.no`, owner/review-verified) vs an
// `experiences` row `…norway-s-oldest-distillery-tours-tastings--68220487`
// whose `booking_url` is `atlungstad.no` — a DIFFERENT real business (a
// riding school) that happens to share the place-name "Atlungstad". A guest
// who books via the experience entry is misdirected.
//
// NOT the same thing as GET /admin/gardssalg-provider-dedup-audit (lokal#440,
// routes/opplevelser.ts ~line 5975) — that endpoint dedupes
// `experience_providers` rows against EACH OTHER across seed sources
// (same-table dedup). This module is a cross-TABLE identity check: producer
// vs. experience/activity.
//
// ─── Matching design ────────────────────────────────────────────────────────
// Two independent signals decide whether a (producer, experience) pair is
// plausibly the SAME real-world business — either is sufficient on its own:
//
//   1. provider_link — experience.provider_id already equals the producer's
//      id. Strongest possible signal (an existing FK), always trusted.
//
//   2. name_token — a significant (>=5 char, post-normalization) token is
//      shared between the producer's searchable name (gardssalgSearchName()
//      strips the catalog's "— Sted" display suffix, experience-store.ts) and
//      the experience's title/title_no. Reuses titleTokens() from
//      experience-dedup.ts (the SAME tokenizer/stopword-list/diacritics-fold/
//      pluralization-stem this repo's other title-fuzzy-matching already
//      uses) rather than inventing a second one. Deliberately does NOT reuse
//      titlesMatch()'s whole-string-similarity fallback branch (the "no
//      shared token but near-identical wording" case): that branch exists for
//      re-harvested clones of the SAME title text (experience-dedup.ts's own
//      problem), which is not this problem's shape — a company name and an
//      unrelated-looking activity title sharing zero tokens should not be
//      treated as a match just because they happen to be similarly SHORT
//      strings, and skipping it also avoids paying titlesMatch's per-pair
//      Levenshtein cost across the full producer × experience cross product.
//
//   3. host_name — the experience's booking_url resolves to a host whose
//      registrable-domain label (e.g. "atlungstad" out of "atlungstad.no")
//      exactly equals one of the producer's own significant name tokens. This
//      is what actually catches the confirmed Atlungstad case: its harvested
//      experience title is a generic marketing phrase ("Norway's Oldest
//      Distillery: Tours & Tastings") that shares no token with "Atlungstad
//      Brenneri" at all — the ONLY textual trace of the real business name is
//      in the (wrong) booking_url's host, which happens to carry the shared
//      place-name. Precisely the "en annen virksomhet med lignende navn"
//      (a different business with a similar name) shape the dev-request
//      names as the reason a naive domain-vs-name heuristic missed it before.
//
// Once a pair is matched (by any signal), its `status` is decided purely by
// comparing registrable domains — producer.hjemmeside is the dev-request's
// designated source of truth ("produsentens verifiserte hjemmeside er
// fasit"): "agree" (same registrable domain), "conflict" (both resolve, and
// differ), or "unknown" (either side is blank/unparseable — never guessed).
//
// catalog_hidden is NEVER used to exclude a producer from the SCAN (task
// spec): a hidden producer's conflicting duplicate is still worth knowing
// about, just noted via `producer_hidden` in the pair.

import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { hostFromUrlLike, registrableDomain, isDirectoryOrAggregatorHost } from "./cross-source-validator";
import { titleTokens, normalizeExperienceTitle } from "./experience-dedup";
import { gardssalgSearchName, isExperienceContentLocked } from "./experience-store";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GsExpProducerRow {
  id: string;
  navn: string;
  hjemmeside: string | null;
  catalog_hidden: number | null;
  fylke?: string | null;
  kommune?: string | null;
}

export interface GsExpExperienceRow {
  id: string;
  title: string;
  title_no: string | null;
  booking_url: string | null;
  provider_id: string | null;
  content_source?: string | null;
  verification_status?: string | null;
  content_field_evidence?: string | null;
}

export type GsExpMatchBasis = "provider_link" | "name_token" | "host_name";
export type GsExpConflictStatus = "conflict" | "agree" | "unknown";

export interface GsExpMatchedPair {
  producer_id: string;
  producer_name: string;
  producer_hidden: boolean;
  producer_hjemmeside: string | null;
  experience_id: string;
  experience_title: string;
  experience_booking_url: string | null;
  match_basis: GsExpMatchBasis;
  status: GsExpConflictStatus;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Registrable domain of any URL-like string (hjemmeside OR booking_url —
 *  the same host/registrable-domain derivation experience-store.ts's own
 *  homepageRegistrableDomain() uses, generalized to a plain param name since
 *  this file applies it to both sides). Null when blank/unparseable — never
 *  guessed. */
function urlRegistrableDomain(urlLike: string | null | undefined): string | null {
  if (!urlLike || !urlLike.trim()) return null;
  const host = hostFromUrlLike(urlLike);
  return host ? registrableDomain(host) : null;
}

// A shared token this long is distinctive enough to treat as a genuine
// name-mention rather than an incidental short word — mirrors
// experience-dedup.ts's SIGNIFICANT_TOKEN_MIN_LEN (that constant is not
// exported; the value itself, 5, is the convention being reused).
const NAME_TOKEN_MIN_LEN = 5;
// Host-label tokens are typically shorter/denser than prose tokens (bare
// domain labels, no filler words diluting them) — 4 chars is enough to avoid
// generic 3-letter false positives (e.g. "mat") without missing real short
// brand names.
const HOST_TOKEN_MIN_LEN = 4;

function producerTokenSet(navn: string): Set<string> {
  return new Set(titleTokens(gardssalgSearchName(navn)));
}

function experienceTokenSet(title: string, titleNo: string | null | undefined): Set<string> {
  const set = new Set(titleTokens(title));
  if (titleNo && titleNo.trim()) {
    for (const t of titleTokens(titleNo)) set.add(t);
  }
  return set;
}

function hasSignificantOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) {
    if (t.length >= NAME_TOKEN_MIN_LEN && b.has(t)) return true;
  }
  return false;
}

/** The normalized first label of a booking_url's registrable domain (e.g.
 *  "atlungstad" out of "https://atlungstad.no/") — null when unparseable or
 *  too short to be meaningful on its own. */
function hostLabelToken(urlLike: string | null | undefined): string | null {
  const root = urlRegistrableDomain(urlLike);
  if (!root) return null;
  const label = root.split(".")[0] || "";
  const normalized = normalizeExperienceTitle(label).replace(/\s+/g, "");
  return normalized.length >= HOST_TOKEN_MIN_LEN ? normalized : null;
}

/**
 * Core matcher — pure, no DB access. Precomputes each experience's token set
 * / host-label once (not once per producer), so this stays O(producers ×
 * experiences) in cheap Set operations rather than O(producers × experiences
 * × tokenization+Levenshtein) — the corpus size this endpoint deals with in
 * production is small (a few dozen gårdssalg producers × the `experiences`
 * catalog), but this keeps the admin endpoint responsive regardless.
 */
export function findGardssalgProducerExperienceMatches(
  producers: GsExpProducerRow[],
  experiences: GsExpExperienceRow[]
): GsExpMatchedPair[] {
  const precomputed = experiences.map((exp) => ({
    row: exp,
    tokens: experienceTokenSet(exp.title, exp.title_no),
    hostLabel: hostLabelToken(exp.booking_url),
    expDomain: urlRegistrableDomain(exp.booking_url),
  }));

  const pairs: GsExpMatchedPair[] = [];

  for (const producer of producers) {
    const pTokens = producerTokenSet(producer.navn);
    const producerDomain = urlRegistrableDomain(producer.hjemmeside);

    for (const pc of precomputed) {
      const exp = pc.row;
      let basis: GsExpMatchBasis | null = null;

      if (exp.provider_id && exp.provider_id === producer.id) {
        basis = "provider_link";
      } else if (hasSignificantOverlap(pTokens, pc.tokens)) {
        basis = "name_token";
      } else if (pc.hostLabel && pTokens.has(pc.hostLabel)) {
        basis = "host_name";
      }

      if (!basis) continue;

      let status: GsExpConflictStatus;
      if (!producerDomain || !pc.expDomain) status = "unknown";
      else if (producerDomain === pc.expDomain) status = "agree";
      else status = "conflict";

      pairs.push({
        producer_id: producer.id,
        producer_name: producer.navn,
        producer_hidden: producer.catalog_hidden === 1,
        producer_hjemmeside: producer.hjemmeside,
        experience_id: exp.id,
        experience_title: exp.title,
        experience_booking_url: exp.booking_url,
        match_basis: basis,
        status,
      });
    }
  }

  return pairs;
}

export interface GsExpConflictSummary {
  matched_pairs: number;
  conflicting: number;
  agreeing: number;
  unknown: number;
}

export function summarizeGardssalgExperienceConflicts(pairs: GsExpMatchedPair[]): GsExpConflictSummary {
  const summary: GsExpConflictSummary = { matched_pairs: pairs.length, conflicting: 0, agreeing: 0, unknown: 0 };
  for (const p of pairs) {
    if (p.status === "conflict") summary.conflicting++;
    else if (p.status === "agree") summary.agreeing++;
    else summary.unknown++;
  }
  return summary;
}

// ─── DB loaders (Part A) ────────────────────────────────────────────────────

const GARDSSALG_PROVIDER_SCOPE_SQL =
  `(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed') AND (producer_type IS NULL OR producer_type != 'test-gardssalg')`;

/** Every gårdssalg producer — same base scoping WHERE clause as
 *  GET /admin/gardssalg-provider-dedup-audit (lokal#440) and
 *  GET /admin/gardssalg-outreach-readiness, MINUS the outreach-readiness
 *  endpoint's deliberate inclusion of catalog_hidden rows in scope — this
 *  scan intentionally does NOT filter catalog_hidden OUT (task spec: a
 *  hidden producer's conflicting duplicate is still worth surfacing), it is
 *  just noted per-row via `producer_hidden`. */
export function loadGardssalgProducersForConflictScan(db: Database.Database): GsExpProducerRow[] {
  return db
    .prepare(
      `SELECT id, navn, hjemmeside, catalog_hidden, fylke, kommune
         FROM experience_providers
        WHERE ${GARDSSALG_PROVIDER_SCOPE_SQL}`
    )
    .all() as GsExpProducerRow[];
}

/** Every LIVE experience row (canonical_id IS NULL — same "never surface a
 *  dedup-merged-away row" convention enforced everywhere else `experiences`
 *  is read: PUBLISH_GATE_SQL, listCategories, GET .../recently-enriched, the
 *  dedup candidate loader itself). Deliberately not scoped to gårdssalg in
 *  any way (category/producer_type) — the whole point is that the matching
 *  experience row was harvested independently and has no such link yet. */
export function loadExperiencesForConflictScan(db: Database.Database): GsExpExperienceRow[] {
  return db
    .prepare(
      `SELECT id, title, title_no, booking_url, provider_id, content_source,
              verification_status, content_field_evidence
         FROM experiences
        WHERE canonical_id IS NULL`
    )
    .all() as GsExpExperienceRow[];
}

/** Full Part A pass: load both sides fresh from the DB and match them. Pure
 *  read — no writes anywhere on this path. */
export function runGardssalgExperienceConflictScan(db: Database.Database): {
  pairs: GsExpMatchedPair[];
  summary: GsExpConflictSummary;
} {
  const producers = loadGardssalgProducersForConflictScan(db);
  const experiences = loadExperiencesForConflictScan(db);
  const pairs = findGardssalgProducerExperienceMatches(producers, experiences);
  return { pairs, summary: summarizeGardssalgExperienceConflicts(pairs) };
}

// ─── Remediation (Part B — write, dry-run by default) ──────────────────────
//
// For every CONFLICTING pair (never "agree"/"unknown" — those are never
// touched), the producer's verified hjemmeside is authoritative. The
// remediation either (a) corrects the experience's booking_url to the
// producer's hjemmeside, or (b) nulls it out when copying the producer's own
// hjemmeside would itself be unsafe — namely when that hjemmeside resolves to
// a directory/aggregator host (isDirectoryOrAggregatorHost, the SAME curated
// classifier the website-discovery/content-refresh routes already use to
// keep aggregator links out of a "verified own site" field) or is otherwise
// unparseable. Never leaves a row in conflict either way.
//
// Deliberately NOT built on applyExperienceContent() (experience-store.ts):
// that writer is fill-ONLY (isBlank(row.<field>) gate) — booking_url here is
// already non-blank and WRONG, which is exactly the case that writer refuses
// to touch by design. This is a corrective overwrite, a genuinely different
// operation, hence its own writer + its own audit table
// (experience_provider_conflict_audit, init-experiences.ts) rather than
// stretching the fill-only one to do something it was deliberately built not
// to do.

export const EXPERIENCE_CONFLICT_ROLLBACKABLE_FIELDS = new Set(["booking_url"]);
// Marker stamped on audit rows inserted by a rollback of THIS table, mirrors
// experience-store.ts's GARDSSALG_ROLLBACK_MARKER convention exactly (kept as
// its own local constant rather than importing that unexported one).
export const EXPERIENCE_CONFLICT_ROLLBACK_MARKER = "internal://rollback";

export interface GsExpConflictPlanItem {
  experience_id: string;
  producer_id: string;
  producer_name: string;
  old_value: string | null;
  new_value: string | null;
  action: "corrected" | "nulled";
}

export interface GsExpConflictSkip {
  experience_id: string;
  producer_id: string;
  reason: "locked" | "already_current" | "no_producer_hjemmeside";
}

/**
 * Plan the remediation for a set of already-diagnosed conflicting pairs
 * (callers should pass ONLY status==="conflict" pairs — see the route, which
 * filters runGardssalgExperienceConflictScan()'s fresh output rather than
 * trusting a client-supplied list). Re-reads each experience's CURRENT row
 * (never trusts the pair's snapshot) so a plan is always computed against
 * live data, same discipline as planGardssalgContentRollback.
 */
export function planGardssalgExperienceConflictRemediation(
  db: Database.Database,
  conflictingPairs: GsExpMatchedPair[]
): { applicable: GsExpConflictPlanItem[]; skipped: GsExpConflictSkip[] } {
  const applicable: GsExpConflictPlanItem[] = [];
  const skipped: GsExpConflictSkip[] = [];

  for (const pair of conflictingPairs) {
    const row = db
      .prepare(`SELECT booking_url, content_source, verification_status FROM experiences WHERE id = ?`)
      .get(pair.experience_id) as
      | { booking_url: string | null; content_source: string | null; verification_status: string | null }
      | undefined;
    if (!row) {
      skipped.push({ experience_id: pair.experience_id, producer_id: pair.producer_id, reason: "already_current" });
      continue;
    }
    if (isExperienceContentLocked(row)) {
      skipped.push({ experience_id: pair.experience_id, producer_id: pair.producer_id, reason: "locked" });
      continue;
    }
    if (!pair.producer_hjemmeside || !pair.producer_hjemmeside.trim()) {
      skipped.push({
        experience_id: pair.experience_id,
        producer_id: pair.producer_id,
        reason: "no_producer_hjemmeside",
      });
      continue;
    }

    const producerHomepage = pair.producer_hjemmeside.trim();
    const producerHost = hostFromUrlLike(producerHomepage);
    const safeToCopy = !!producerHost && !isDirectoryOrAggregatorHost(producerHost);
    const newValue = safeToCopy ? producerHomepage : null;

    if ((row.booking_url ?? null) === newValue) {
      skipped.push({ experience_id: pair.experience_id, producer_id: pair.producer_id, reason: "already_current" });
      continue;
    }

    applicable.push({
      experience_id: pair.experience_id,
      producer_id: pair.producer_id,
      producer_name: pair.producer_name,
      old_value: row.booking_url ?? null,
      new_value: newValue,
      action: safeToCopy ? "corrected" : "nulled",
    });
  }

  return { applicable, skipped };
}

/**
 * Apply a previously-planned remediation: writes experiences.booking_url,
 * merges/retracts the `booking_url` key of experiences.content_field_evidence
 * (retracted — key deleted — on a "nulled" action, since a null value makes no
 * provenance claim; set to the producer's hjemmeside on a "corrected" action,
 * the same "where did this value come from" convention applyExperienceContent
 * already uses for that column), and inserts ONE
 * experience_provider_conflict_audit row per write — the rollback lever.
 * content_source is deliberately left untouched: this write did not come from
 * a homepage fetch of the EXPERIENCE's own site, so stamping
 * content_source='provider_site' would misrepresent its provenance the exact
 * way the content_field_evidence per-field map (not a row-level column) was
 * built to prevent (see applyExperienceContent's own doc comment).
 */
export function applyGardssalgExperienceConflictRemediation(
  db: Database.Database,
  items: GsExpConflictPlanItem[],
  batchId: string | null
): Array<{ experience_id: string; producer_id: string; new_value: string | null; action: string }> {
  const applied: Array<{ experience_id: string; producer_id: string; new_value: string | null; action: string }> = [];

  const runOne = db.transaction((item: GsExpConflictPlanItem) => {
    const row = db
      .prepare(`SELECT content_field_evidence FROM experiences WHERE id = ?`)
      .get(item.experience_id) as { content_field_evidence: string | null } | undefined;

    let evidence: Record<string, string> = {};
    if (row?.content_field_evidence) {
      try {
        const parsed = JSON.parse(row.content_field_evidence);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          evidence = parsed as Record<string, string>;
        }
      } catch {
        /* malformed -> start fresh rather than throw on a remediation write */
      }
    }
    if (item.action === "corrected") {
      evidence.booking_url = `producer:${item.producer_id}`;
    } else {
      delete evidence.booking_url;
    }

    db.prepare(
      `UPDATE experiences
          SET booking_url = @booking_url,
              content_field_evidence = @content_field_evidence,
              updated_at = datetime('now')
        WHERE id = @id`
    ).run({
      id: item.experience_id,
      booking_url: item.new_value,
      content_field_evidence: JSON.stringify(evidence),
    });

    db.prepare(
      `INSERT INTO experience_provider_conflict_audit
         (id, experience_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @experience_id, 'booking_url', @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      experience_id: item.experience_id,
      old_value: item.old_value,
      new_value: item.new_value,
      source_url: `producer:${item.producer_id}`,
      batch_id: batchId,
    });
  });

  for (const item of items) {
    runOne(item);
    applied.push({
      experience_id: item.experience_id,
      producer_id: item.producer_id,
      new_value: item.new_value,
      action: item.action,
    });
  }

  return applied;
}

// ─── Rollback (wired into the EXISTING POST /admin/gardssalg-content-rollback
// endpoint via an `entity_type` switch, per the dev-request's own rollback
// section — see routes/opplevelser.ts) ──────────────────────────────────────

export type GsExpConflictRollbackTarget = { experience_id?: string; batch_id?: string };

export interface GsExpConflictRollbackPlanItem {
  experience_id: string;
  field_name: string;
  current_value: string | null;
  restore_to: string | null;
}

export interface GsExpConflictRollbackSkip {
  experience_id: string;
  field_name: string;
  reason: "no_audit_row" | "already_current" | "unknown_field" | "locked";
}

function resolveExperienceConflictRollbackTargets(
  db: Database.Database,
  opts: GsExpConflictRollbackTarget
): Array<{ experience_id: string; field_name: string }> {
  if (opts.batch_id) {
    return db
      .prepare(`SELECT DISTINCT experience_id, field_name FROM experience_provider_conflict_audit WHERE batch_id = ?`)
      .all(opts.batch_id) as Array<{ experience_id: string; field_name: string }>;
  }
  if (opts.experience_id) {
    const rows = db
      .prepare(`SELECT DISTINCT field_name FROM experience_provider_conflict_audit WHERE experience_id = ?`)
      .all(opts.experience_id) as Array<{ field_name: string }>;
    return rows.map((r) => ({ experience_id: opts.experience_id as string, field_name: r.field_name }));
  }
  return [];
}

/** Mirrors planGardssalgContentRollback's exact idempotency discipline
 *  (experience-store.ts) — same two "nothing to restore" cases (already at
 *  the restore target; latest audit row IS a previous rollback whose
 *  new_value already matches current) — adapted to this table/FK. */
export function planExperienceConflictRollback(
  db: Database.Database,
  opts: GsExpConflictRollbackTarget
): { restorable: GsExpConflictRollbackPlanItem[]; skipped: GsExpConflictRollbackSkip[] } {
  const targets = resolveExperienceConflictRollbackTargets(db, opts);
  const restorable: GsExpConflictRollbackPlanItem[] = [];
  const skipped: GsExpConflictRollbackSkip[] = [];

  for (const t of targets) {
    if (!EXPERIENCE_CONFLICT_ROLLBACKABLE_FIELDS.has(t.field_name)) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "unknown_field" });
      continue;
    }
    const latest = db
      .prepare(
        `SELECT old_value, new_value, source_url FROM experience_provider_conflict_audit
          WHERE experience_id = ? AND field_name = ?
          ORDER BY rowid DESC LIMIT 1`
      )
      .get(t.experience_id, t.field_name) as
      | { old_value: string | null; new_value: string | null; source_url: string | null }
      | undefined;
    if (!latest) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "no_audit_row" });
      continue;
    }
    const expRow = db
      .prepare(`SELECT ${t.field_name} AS current_value, content_source, verification_status FROM experiences WHERE id = ?`)
      .get(t.experience_id) as
      | { current_value: string | null; content_source: string | null; verification_status: string | null }
      | undefined;
    if (!expRow) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "no_audit_row" });
      continue;
    }
    if (isExperienceContentLocked(expRow)) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "locked" });
      continue;
    }
    const currentValue = expRow.current_value ?? null;
    const alreadyAtRestoreTarget = currentValue === (latest.old_value ?? null);
    const alreadyRolledBack =
      latest.source_url === EXPERIENCE_CONFLICT_ROLLBACK_MARKER && currentValue === (latest.new_value ?? null);
    if (alreadyAtRestoreTarget || alreadyRolledBack) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "already_current" });
      continue;
    }
    restorable.push({
      experience_id: t.experience_id,
      field_name: t.field_name,
      current_value: currentValue,
      restore_to: latest.old_value ?? null,
    });
  }

  return { restorable, skipped };
}

/** Mirrors applyGardssalgContentRollback exactly (experience-store.ts),
 *  adapted to this table/FK: restores the field, inserts a NEW audit row
 *  (never mutates/deletes existing ones) stamped with
 *  EXPERIENCE_CONFLICT_ROLLBACK_MARKER so the rollback itself is auditable
 *  and the same idempotency check above can recognize it next time. */
export function applyExperienceConflictRollback(
  db: Database.Database,
  items: GsExpConflictRollbackPlanItem[]
): Array<{ experience_id: string; field_name: string; restored_to: string | null }> {
  const restored: Array<{ experience_id: string; field_name: string; restored_to: string | null }> = [];

  const runOne = db.transaction((item: GsExpConflictRollbackPlanItem) => {
    db.prepare(`UPDATE experiences SET ${item.field_name} = @val WHERE id = @id`).run({
      val: item.restore_to,
      id: item.experience_id,
    });
    db.prepare(
      `INSERT INTO experience_provider_conflict_audit
         (id, experience_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @experience_id, @field_name, @old_value, @new_value, @source_url, NULL, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      experience_id: item.experience_id,
      field_name: item.field_name,
      old_value: item.current_value,
      new_value: item.restore_to,
      source_url: EXPERIENCE_CONFLICT_ROLLBACK_MARKER,
    });
  });

  for (const item of items) {
    if (!EXPERIENCE_CONFLICT_ROLLBACKABLE_FIELDS.has(item.field_name)) continue;
    const expRow = db
      .prepare(`SELECT content_source, verification_status FROM experiences WHERE id = ?`)
      .get(item.experience_id) as { content_source: string | null; verification_status: string | null } | undefined;
    if (expRow && isExperienceContentLocked(expRow)) continue;
    runOne(item);
    restored.push({ experience_id: item.experience_id, field_name: item.field_name, restored_to: item.restore_to });
  }

  return restored;
}
