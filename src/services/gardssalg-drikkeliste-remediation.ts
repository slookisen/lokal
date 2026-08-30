// ─── Gårdssalg drikkeliste §4a–§4e data-quality remediation batch ──────────
//
// ROUND 2 (dev-request 2026-08-30-drikkeliste-remediering-runde-2,
// daniel_authorized) EXTENDS this same module/lever rather than duplicating
// it — three follow-on additions, each near its closest §4a-§4e relative:
//   Del A — GS_ROUND2_TERMINAL_ITEMS / processGsRound2TerminalItem, just
//     below processGs4aItem: terminal-mark + twin_link (no merge) for the 15
//     holding rows §4a's own org_nr-conflict guard correctly rejected.
//   Del B — a `providerId` field added to every §4a/§4c/§4d/§4e item/
//     selector shape, checked before the existing name/website/org.nr
//     lookup, for the 10 rows round 1 left unresolved on name ambiguity
//     alone.
//   Del C — GS_ROUND2_POSTAL_PREFILL_ITEMS (just above the orchestrator, near
//     §4e) plus a 16th GS_ROUND2_TERMINAL_ITEMS entry (Telemark Bryggeri).
// See each section's own doc comment for the detail. Nothing below this
// paragraph, and no round-1 row/write, changes because of round 2.
//
// dev-request 2026-08-29-drikkeliste-remapping-og-dodkilde. A 306-row
// source-breadth review of the drink-producer catalog found 64 rows that
// are not operative producers (holdings, bankrupt entities, hobby
// registrations, wrong stored websites, missing org numbers, duplicate
// rows). This module is the ORCHESTRATION layer for that one-time cleanup:
// it holds the five source lists (§4a–§4e, verbatim from the report) as
// plain data, resolves each row against the LIVE `experience_providers`
// catalog at call time (never against a fixed id — the catalog is the
// source of truth, not this file), and executes the correct EXISTING
// primitive for each row:
//
//   §4a (holding/empty-entity remapping) -> either
//     - services/gardssalg-provider-merge.ts's dedup-merge lever, when a
//       separate row already exists at the target operating org.nr, or
//     - applyGardssalgSetOrgNr (experience-store.ts, new for this batch),
//       when it doesn't (in-place correction) — the branch is decided by
//       a FRESH read of the live catalog at the moment each row is
//       processed, not precomputed, so a multi-source-one-target item
//       (Fjellbryggeriet DA ×2, the four Arcus feeder brands) naturally
//       resolves as "first row corrects in place, every subsequent row
//       merges into that now-corrected row" — see virtualOrgNrMap below
//       for how a dry-run reproduces that same sequencing without writing.
//   §4b (non-operative rows) -> applyGardssalgSetTerminalStatus (existing),
//     terminal_status='dod_kilde', evidence class embedded in `reason`.
//   §4c (leftover duplicate pairs) -> the same dedup-merge lever as §4a,
//     survivor picked via Daniel's own documented rule (gardssalg-provider-
//     merge.ts's module doc comment): the row NOT owner-claimed and with
//     the least-blank data loses, unless there's a tie, then the older row
//     (earlier created_at) survives.
//   §4d (wrong/dead stored websites) -> applyGardssalgSetHjemmeside
//     (experience-store.ts, new for this batch).
//   §4e (missing org.nr) -> the EXISTING POST /admin/gardssalg-orgnr-
//     backfill route, called in-process (injected via `callBackfill` — this
//     module never imports the express router, to avoid a circular
//     dependency with routes/opplevelser.ts, which imports FROM this
//     module). Its own Brreg-resolved org.nr is cross-checked against the
//     report's stated expected value; a mismatch or a veto is reported,
//     never silently trusted one way or the other.
//
// Every write funnels through the SAME gardssalg_content_audit table every
// other write in this vertical already uses (via the primitives above) —
// this module invents no new audit mechanism, matching the dev-request's
// own "no new audit mechanism" instruction. Nothing is ever hard-deleted.
//
// "Don't guess" is load-bearing throughout this file: every resolution
// helper below requires an UNAMBIGUOUS match (exactly one candidate row) to
// proceed: zero matches -> unresolved ("not found"), more than one match ->
// unresolved ("ambiguous"). No fuzzy/best-guess fallback exists anywhere in
// this module.

import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import {
  applyGardssalgSetTerminalStatus,
  applyGardssalgSetOrgNr,
  applyGardssalgSetHjemmeside,
  applyGardssalgProviderAddress,
} from "./experience-store";
import {
  previewGardssalgProviderMergePair,
  applyGardssalgProviderMergePair,
} from "./gardssalg-provider-merge";

/** Stamped on the audit note of every write this module makes that doesn't already carry its own report-note text. */
export const GS_DRIKKELISTE_REMEDIATION_MARKER = "internal://drikkeliste-remediation";

// ── Shared row snapshot / resolution helpers ────────────────────────────────

interface ProviderSnapshot {
  id: string;
  navn: string;
  org_nr: string | null;
  hjemmeside: string | null;
  merged_into: string | null;
  terminal_status: string | null;
  epost: string | null;
  telefon: string | null;
  about_text: string | null;
  created_at: string | null;
  content_source: string | null;
}

const SNAPSHOT_COLS =
  "id, navn, org_nr, hjemmeside, merged_into, terminal_status, epost, telefon, about_text, created_at, content_source";

function findByOrgNr(db: Database.Database, orgNr: string): ProviderSnapshot | null {
  const row = db.prepare(`SELECT ${SNAPSHOT_COLS} FROM experience_providers WHERE org_nr = ?`).get(orgNr) as
    | ProviderSnapshot
    | undefined;
  return row ?? null;
}

function findById(db: Database.Database, id: string): ProviderSnapshot | null {
  const row = db.prepare(`SELECT ${SNAPSHOT_COLS} FROM experience_providers WHERE id = ?`).get(id) as
    | ProviderSnapshot
    | undefined;
  return row ?? null;
}

/** Case-insensitive substring match on navn. Excludes already-merged rows unless includeMerged is set. */
function findByNameContains(
  db: Database.Database,
  hint: string,
  opts: { excludeIds?: Set<string>; includeMerged?: boolean } = {},
): ProviderSnapshot[] {
  const rows = db
    .prepare(`SELECT ${SNAPSHOT_COLS} FROM experience_providers WHERE navn LIKE ?`)
    .all(`%${hint}%`) as ProviderSnapshot[];
  return rows.filter((r) => (opts.includeMerged || r.merged_into === null) && !(opts.excludeIds?.has(r.id)));
}

/** Case-insensitive substring match on hjemmeside (used for §4d rows resolved by their stored/dead domain, not name). */
function findByWebsiteContains(db: Database.Database, hint: string): ProviderSnapshot[] {
  const rows = db
    .prepare(`SELECT ${SNAPSHOT_COLS} FROM experience_providers WHERE hjemmeside LIKE ?`)
    .all(`%${hint}%`) as ProviderSnapshot[];
  return rows.filter((r) => r.merged_into === null);
}

/**
 * Daniel's own survivorship rule (quoted verbatim in gardssalg-provider-
 * merge.ts's module doc comment): the row with the "worse data" is the one
 * removed. Non-blank count across the 5 contact/content fields decides;
 * a tie falls back to the OLDER row (earlier created_at) as the survivor —
 * the more established catalog entry. Only reached for §4c pairs where no
 * org.nr/holding-vs-operating direction was given by the report (§4a always
 * has an explicit direction and never calls this).
 */
function nonBlankCount(r: ProviderSnapshot): number {
  return [r.org_nr, r.hjemmeside, r.epost, r.telefon, r.about_text].filter((v) => v !== null && v !== "").length;
}
function pickSurvivor(a: ProviderSnapshot, b: ProviderSnapshot): { keep: ProviderSnapshot; remove: ProviderSnapshot } {
  const ca = nonBlankCount(a);
  const cb = nonBlankCount(b);
  if (ca !== cb) return ca > cb ? { keep: a, remove: b } : { keep: b, remove: a };
  const aCreated = a.created_at ?? "";
  const bCreated = b.created_at ?? "";
  return aCreated <= bCreated ? { keep: a, remove: b } : { keep: b, remove: a };
}

/** Idempotent: a rerun of the twin-link note (e.g. a second `apply` batch run) must not accumulate duplicate audit rows for the same pair. */
function twinLinkAlreadyRecorded(db: Database.Database, providerId: string, otherId: string): boolean {
  const row = db
    .prepare(
      `SELECT id FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'twin_link' AND new_value = ?`,
    )
    .get(providerId, otherId) as { id: string } | undefined;
  return !!row;
}

function insertTwinLinkAudit(
  db: Database.Database,
  providerId: string,
  otherId: string,
  batchId: string,
  note: string,
): void {
  if (twinLinkAlreadyRecorded(db, providerId, otherId)) return;
  db.prepare(
    `INSERT INTO gardssalg_content_audit
       (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at, notes)
     VALUES (@id, @provider_id, 'twin_link', NULL, @new_value, @source_url, @batch_id, 'admin', datetime('now'), @notes)`,
  ).run({
    id: uuid(),
    provider_id: providerId,
    new_value: otherId,
    source_url: GS_DRIKKELISTE_REMEDIATION_MARKER,
    batch_id: batchId,
    notes: note,
  });
}

// ── Report row shape ─────────────────────────────────────────────────────

export type GsDrikkelisteCategory = "4a" | "4b" | "4c" | "4d" | "4e";

/**
 * One outcome per (item, source-selector) processed. `outcome` is
 * intentionally a loose string rather than a closed union — the possible
 * values differ per method (merge outcomes come straight from
 * GardssalgProviderMergeOutcome; the others are this module's own small,
 * documented vocabulary: {would_,}terminal_marked/marked,
 * {would_,}org_nr_corrected/corrected, {would_,}hjemmeside_corrected,
 * already_terminal, already_merged_skip, twin_linked/would_twin_link,
 * deferred_to_4e, backfilled_match/would_backfill_match/
 * backfilled_mismatch/backfilled_vetoed/already_filled, unresolved,
 * rejected, error).
 */
export interface GsDrikkelisteRowResult {
  category: GsDrikkelisteCategory;
  key: string;
  label: string;
  method: "merge" | "org_nr_correction" | "terminal_status" | "hjemmeside" | "orgnr_backfill" | "twin_link" | "none";
  outcome: string;
  provider_id?: string;
  remove_id?: string;
  keep_id?: string;
  old_value?: string | null;
  new_value?: string | null;
  expected_value?: string | null;
  reason?: string | null;
}

interface Ctx {
  apply: boolean;
  batchId: string;
  claimed: Set<string>;
  /**
   * Multi-source-one-target items (Fjellbryggeriet DA ×2, the four Arcus
   * feeder brands) genuinely mutate the catalog mid-batch under `apply`:
   * the FIRST source row corrects in place (path A), so the SECOND source
   * row's target-lookup then finds a real row and merges into it instead.
   * A dry run makes no real writes, so it can't rely on that real DB state
   * change to reproduce the same sequencing — this map is the same
   * sequencing simulated in memory (target org.nr -> the source row that
   * "would" now hold it), consulted by resolveGs4aTarget exactly like a
   * real DB row would be. Populated in BOTH apply and dry-run (harmless/
   * redundant in apply — the real DB read already agrees), so the two
   * modes report the identical branching decision for these items.
   */
  virtualOrgNrMap: Map<string, string>;
}

// ── §4a — re-mapping ─────────────────────────────────────────────────────

interface Gs4aSourceSelector {
  orgNr?: string;
  nameHint?: string;
  /**
   * Round-2 addition (dev-request 2026-08-30-drikkeliste-remediering-runde-2,
   * Del B): an explicit provider_id, checked BEFORE orgNr/nameHint when
   * present. Round 1's name-only lookup left 10 rows unresolved purely
   * because a bare name hint was ambiguous (multiple candidates) or the
   * expected row-count didn't match — an id sidesteps that ambiguity
   * entirely (still gated by the SAME claimed/merged_into checks every other
   * resolution path here already enforces, so it's still not a raw trust of
   * caller input). Never invented/guessed in this file's own data — every
   * value that appears here was cross-checked against a live read-only
   * catalog lookup at authoring time; see the item's own comment for how.
   */
  providerId?: string;
}
interface Gs4aTarget {
  orgNr?: string;
  nameHint?: string;
  /** Round-2 addition — see Gs4aSourceSelector.providerId's doc comment; same semantics for a target row. */
  providerId?: string;
}
interface Gs4aItem {
  key: string;
  label: string;
  sources: Gs4aSourceSelector[];
  target?: Gs4aTarget;
  special?: "terminal_dead_source" | "twin_link" | "defer_to_4e";
  note: string;
}

export const GS_4A_ITEMS: Gs4aItem[] = [
  // NB: 15 keys formerly listed here (simple-spotting, svalbard-distillery,
  // geir-bakken, erik-juel-karlsen-eid, ale-mates, tradish-holding,
  // guajiro-holding, lutlaget-jaastad, monkey-businessmen, ringnes-norge,
  // arcus-loiten, arcus-oplandske, arcus-siemers, arcus-lysholm,
  // njot-aga-sideri) moved to GS_ROUND2_TERMINAL_ITEMS below — round-2
  // dev-request 2026-08-30-drikkeliste-remediering-runde-2, Del A. Round 1's
  // real apply run found every one of these 15 rejected by the merge lever's
  // own org_nr-conflict guard (both the holding and the operating company
  // legitimately carry their own, different, already-populated org.nr — the
  // guard is right to refuse a MERGE there). Daniel's decision for exactly
  // this named cohort (daniel-responses/2026-08-30-go-ukjent-ansatte-regel-
  // og-4a-terminal-twin.md): never merge them — terminal-mark the holding row
  // instead and twin_link it to the operating row. See GS_ROUND2_TERMINAL_ITEMS
  // for the new mechanism; this array keeps every OTHER §4a item unchanged.
  {
    key: "frewi-wilsgard",
    label: "Frewi → Wilsgård (dup with Wilsgård row)",
    sources: [
      // Round 2 Del B: unambiguous live lookup (single "Frewi" name match) —
      // see PR description for confidence/resolution notes. Target stays
      // name-only: three "Wilsgård"-named rows exist live and none can be
      // confidently picked as "the" operating structure without further
      // Brreg/proff research — deliberately left unresolved (gap), not guessed.
      { orgNr: "989274511", nameHint: "Frewi", providerId: "cd0bd5ad-4a6c-4d70-8bc6-52e6c4df8959" },
    ],
    target: { nameHint: "Wilsgård" },
    note: "§4a dup: Frewi 989274511 → Wilsgård structure (dup with Wilsgård row)",
  },
  {
    key: "geiranger",
    label: "Geiranger row → Geiranger Brenneri",
    sources: [
      // Round 2 Del B: the bare name "Geiranger" matches 16 unrelated tourism
      // rows live — resolved instead via providerId, cross-checked against
      // the live gårdssalg-provider-dedup-audit grouping (this row shares an
      // org_nr-conflict dedup group with the target "Geiranger Brenneri",
      // the only "Geiranger"-named row that is a drink producer).
      { nameHint: "Geiranger", providerId: "cde95a67-283c-4520-803c-b998eb009cb7" },
    ],
    target: { orgNr: "929225236", nameHint: "Geiranger Brenneri" },
    note: "§4a: Geiranger row → Geiranger Brenneri 929225236",
  },
  {
    key: "fjellbryggeriet-da-as",
    label: "Fjellbryggeriet DA (×2 rows) → Fjellbryggeriet AS",
    sources: [
      { orgNr: "995720329", nameHint: "Fjellbryggeriet" },
      { nameHint: "Fjellbryggeriet" },
    ],
    target: { orgNr: "916476450", nameHint: "Fjellbryggeriet AS" },
    note:
      "§4a: Fjellbryggeriet DA 995720329 (×2 rows) → Fjellbryggeriet AS 916476450 " +
      "(operation moved to Tuddal 2015; cf. Tuddal Høyfjellshotel 970951113)",
  },
  {
    key: "lundetangen",
    label: "Lundetangen → unresolvable target (terminal-mark, not a guess)",
    sources: [{ orgNr: "966488948", nameHint: "Lundetangen" }],
    special: "terminal_dead_source",
    note:
      "§4a historisk_merke_uten_kjent_org: Lundetangen 966488948 — brand brewed at a different, " +
      "unresolvable org.nr; no concrete target row found, terminal-marking rather than guessing",
  },
  {
    key: "skifjorden-twin-link",
    label: "Skifjorden coop ↔ operating-AS — keep both, cross-reference only",
    sources: [{ orgNr: "912748146", nameHint: "Skifjorden" }],
    target: { orgNr: "918608893", nameHint: "Skifjorden" },
    special: "twin_link",
    note:
      "§4a: Skifjorden coop 912748146 ↔ operating-AS 918608893 — KEEP BOTH rows; " +
      "cross-reference note only, no merge/hide/remap",
  },
  {
    key: "hardanger-handbryggeri-orgnr",
    label: "Hardanger Handbryggeri — org.nr missing (same row as §4e; done once there)",
    sources: [{ nameHint: "Hardanger Handbryggeri" }],
    special: "defer_to_4e",
    note:
      "§4a: Hardanger Handbryggeri row org.nr missing — SAME row as §4e's Hardanger Handbryggeri entry " +
      "(915218857); processed once via §4e's backfill call, not reprocessed here",
  },
];

/**
 * Resolves one §4a source selector against the live catalog. Org.nr match
 * wins when given and found; falls back to a name-contains match (0 or
 * >1 matches -> unresolved, never guessed). `excludeNameHint` (the item's
 * OWN target nameHint, when it has one) is filtered out of name-based
 * candidates — needed because a bare hint like "Geiranger" would otherwise
 * also match the target row's own name ("Geiranger Brenneri") and falsely
 * report the source as ambiguous.
 */
function resolveGs4aSource(
  db: Database.Database,
  sel: Gs4aSourceSelector,
  claimed: Set<string>,
  excludeNameHint?: string,
): { row: ProviderSnapshot | null; reason: string | null } {
  const excludeByTargetHint = (rows: ProviderSnapshot[]): ProviderSnapshot[] =>
    excludeNameHint ? rows.filter((r) => !r.navn.toLowerCase().includes(excludeNameHint.toLowerCase())) : rows;

  // Round-2 Del B: an explicit provider_id wins outright — no ambiguity is
  // even possible, since a primary-key lookup can only ever find zero or one
  // row. Still respects the SAME claimed/merged_into discipline every other
  // branch below enforces (never re-claims a row another item already used
  // this run; never resolves onto an already-merged/dead row unless the
  // caller explicitly wants that — no caller here does).
  if (sel.providerId) {
    const row = findById(db, sel.providerId);
    if (!row) return { row: null, reason: "provider_id_not_found" };
    if (row.merged_into !== null) return { row: null, reason: "provider_id_already_merged" };
    if (claimed.has(row.id)) return { row: null, reason: "provider_id_already_claimed" };
    return { row, reason: null };
  }

  if (sel.orgNr) {
    const row = findByOrgNr(db, sel.orgNr);
    if (row && !claimed.has(row.id)) return { row, reason: null };
    if (!row && sel.nameHint) {
      const candidates = excludeByTargetHint(findByNameContains(db, sel.nameHint, { excludeIds: claimed }));
      if (candidates.length === 1) return { row: candidates[0], reason: null };
      return { row: null, reason: candidates.length === 0 ? "source_not_found" : `source_ambiguous_${candidates.length}_matches` };
    }
    return { row: null, reason: "source_not_found" };
  }
  const candidates = excludeByTargetHint(findByNameContains(db, sel.nameHint!, { excludeIds: claimed }));
  if (candidates.length === 1) return { row: candidates[0], reason: null };
  return { row: null, reason: candidates.length === 0 ? "source_not_found" : `source_ambiguous_${candidates.length}_matches` };
}

/** Resolves a §4a/§4c target: real DB row by org.nr (checking the virtual overlay first — see Ctx.virtualOrgNrMap), else by name (unambiguous only). */
function resolveGs4aTarget(db: Database.Database, target: Gs4aTarget | undefined, ctx: Ctx): ProviderSnapshot | null {
  if (!target) return null;
  // Round-2 Del B: same providerId-wins-outright rule as resolveGs4aSource
  // above (see its doc comment) — not currently exercised by any live §4a
  // item (every Del B target ambiguity turned out resolvable via the
  // EXISTING orgNr path instead, see PR description), but the mechanism
  // itself must accept one, so it is wired symmetrically with the source side.
  if (target.providerId) return findById(db, target.providerId);
  if (target.orgNr) {
    const virtualId = ctx.virtualOrgNrMap.get(target.orgNr);
    if (virtualId) {
      const row = findById(db, virtualId);
      if (row) return row;
    }
    return findByOrgNr(db, target.orgNr);
  }
  if (target.nameHint) {
    const candidates = findByNameContains(db, target.nameHint, {});
    return candidates.length === 1 ? candidates[0] : null;
  }
  return null;
}

function processGs4aItem(db: Database.Database, item: Gs4aItem, ctx: Ctx): GsDrikkelisteRowResult[] {
  const results: GsDrikkelisteRowResult[] = [];

  if (item.special === "twin_link") {
    const a = item.sources[0].orgNr ? findByOrgNr(db, item.sources[0].orgNr) : null;
    const b = item.target?.orgNr ? findByOrgNr(db, item.target.orgNr) : null;
    if (!a || !b) {
      results.push({
        category: "4a",
        key: item.key,
        label: item.label,
        method: "twin_link",
        outcome: "unresolved",
        reason: "twin_link_side_not_found",
      });
      return results;
    }
    const alreadyLinked = twinLinkAlreadyRecorded(db, a.id, b.id);
    if (ctx.apply) {
      insertTwinLinkAudit(db, a.id, b.id, ctx.batchId, item.note);
      insertTwinLinkAudit(db, b.id, a.id, ctx.batchId, item.note);
    }
    results.push({
      category: "4a",
      key: item.key,
      label: item.label,
      method: "twin_link",
      outcome: alreadyLinked ? "already_twin_linked" : ctx.apply ? "twin_linked" : "would_twin_link",
      provider_id: a.id,
      new_value: b.id,
      reason: item.note,
    });
    return results;
  }

  if (item.special === "defer_to_4e") {
    results.push({
      category: "4a",
      key: item.key,
      label: item.label,
      method: "none",
      outcome: "deferred_to_4e",
      reason: item.note,
    });
    return results;
  }

  for (const sel of item.sources) {
    const { row: sourceRow, reason: unresolvedReason } = resolveGs4aSource(db, sel, ctx.claimed, item.target?.nameHint);
    if (!sourceRow) {
      results.push({
        category: "4a",
        key: item.key,
        label: item.label,
        method: "none",
        outcome: "unresolved",
        reason: unresolvedReason,
      });
      continue;
    }
    ctx.claimed.add(sourceRow.id);

    if (item.special === "terminal_dead_source") {
      if (sourceRow.terminal_status === "dod_kilde") {
        results.push({
          category: "4a",
          key: item.key,
          label: item.label,
          method: "terminal_status",
          provider_id: sourceRow.id,
          outcome: "already_terminal",
          reason: item.note,
        });
        continue;
      }
      if (ctx.apply) {
        const r = applyGardssalgSetTerminalStatus(sourceRow.id, "dod_kilde", item.note, undefined);
        results.push({
          category: "4a",
          key: item.key,
          label: item.label,
          method: "terminal_status",
          provider_id: sourceRow.id,
          outcome: r.ok ? "terminal_marked" : "error",
          old_value: r.ok ? r.old_value : undefined,
          new_value: r.ok ? r.new_value : undefined,
          reason: r.ok ? item.note : r.reason,
        });
      } else {
        results.push({
          category: "4a",
          key: item.key,
          label: item.label,
          method: "terminal_status",
          provider_id: sourceRow.id,
          outcome: "would_terminal_mark",
          old_value: sourceRow.terminal_status,
          new_value: "dod_kilde",
          reason: item.note,
        });
      }
      continue;
    }

    if (!item.target) {
      results.push({
        category: "4a",
        key: item.key,
        label: item.label,
        method: "none",
        provider_id: sourceRow.id,
        outcome: "unresolved",
        reason: "no_target_defined",
      });
      continue;
    }

    const targetRow = resolveGs4aTarget(db, item.target, ctx);

    if (targetRow && targetRow.id !== sourceRow.id) {
      const mergeResult = ctx.apply
        ? applyGardssalgProviderMergePair(db, sourceRow.id, targetRow.id, item.note, ctx.batchId)
        : previewGardssalgProviderMergePair(db, sourceRow.id, targetRow.id);
      results.push({
        category: "4a",
        key: item.key,
        label: item.label,
        method: "merge",
        remove_id: sourceRow.id,
        keep_id: targetRow.id,
        outcome: mergeResult.outcome,
        reason: mergeResult.reason ?? item.note,
      });
      continue;
    }

    if (!targetRow && item.target.orgNr) {
      if (ctx.apply) {
        const r = applyGardssalgSetOrgNr(sourceRow.id, item.target.orgNr, item.note, undefined);
        if (r.ok) {
          ctx.virtualOrgNrMap.set(item.target.orgNr, sourceRow.id);
          results.push({
            category: "4a",
            key: item.key,
            label: item.label,
            method: "org_nr_correction",
            provider_id: sourceRow.id,
            outcome: "org_nr_corrected",
            old_value: r.old_value,
            new_value: r.new_value,
          });
        } else {
          results.push({
            category: "4a",
            key: item.key,
            label: item.label,
            method: "org_nr_correction",
            provider_id: sourceRow.id,
            outcome: "error",
            reason: r.reason,
          });
        }
      } else {
        ctx.virtualOrgNrMap.set(item.target.orgNr, sourceRow.id);
        results.push({
          category: "4a",
          key: item.key,
          label: item.label,
          method: "org_nr_correction",
          provider_id: sourceRow.id,
          outcome: "would_correct_org_nr",
          old_value: sourceRow.org_nr,
          new_value: item.target.orgNr,
        });
      }
      continue;
    }

    results.push({
      category: "4a",
      key: item.key,
      label: item.label,
      method: "none",
      provider_id: sourceRow.id,
      outcome: "unresolved",
      reason: "target_not_resolvable",
    });
  }

  return results;
}

// ── §4a round 2 — holding terminal-mark + twin_link (no merge) ──────────────
//
// dev-request 2026-08-30-drikkeliste-remediering-runde-2, Del A + Del C part
// 2 (daniel_authorized: daniel-responses/2026-08-30-go-ukjent-ansatte-regel-
// og-4a-terminal-twin.md). Covers exactly the rows round 1's own §4a merge
// attempt correctly REJECTED via the org_nr-conflict guard (both source and
// target already carry their own, different, populated org.nr — the guard
// was right to refuse a merge) plus one §4b/§4e row with no operating
// counterpart at all (Telemark Bryggeri — org.nr slettet, nothing to twin to).
// Daniel's decided end-state for this named cohort: never merge — terminal-
// mark the holding/dead-source row (dod_kilde, evidence class embedded in
// `reason` exactly like §4b's `evidence_class=` convention) and, when an
// operating row exists, twin_link the holding row to it (reusing
// insertTwinLinkAudit/twinLinkAlreadyRecorded byte-for-byte — the SAME
// mechanic §4a's own Skifjorden `twin_link` special already uses, just
// ONE-directional here per Daniel's spec, not the mutual link Skifjorden
// gets — Skifjorden keeps BOTH rows as independent, currently-operating
// entities; a holding row has nothing of its own left to point back at).
// `operating` is intentionally optional — Telemark Bryggeri (no operating
// row exists at all) gets ONLY the terminal-mark, no twin_link attempt.
//
// This is a NEW action path for exactly this named cohort, not a change to
// the org_nr-conflict merge gate itself (untouched, still guards every other
// §4a/§4c merge exactly as before) — see this module's own top-of-file doc
// comment and the dev-request's own "Non-goals".

export type GsRound2TerminalEvidenceClass = "holding_drift_i_annet_orgnr" | "brreg_slettet";

interface GsRound2TerminalItem {
  key: string;
  label: string;
  source: Gs4aSourceSelector;
  /** Omitted when there is no operating row to twin_link to (Telemark Bryggeri — org.nr slettet). */
  operating?: Gs4aTarget;
  evidenceClass: GsRound2TerminalEvidenceClass;
  note: string;
}

/**
 * The 15 Del A holding rows + Telemark Bryggeri (Del C part 2). Every
 * source/operating selector here is the SAME {orgNr, nameHint} shape §4a
 * already uses, resolved via the SAME resolveGs4aSource/resolveGs4aTarget
 * helpers (org.nr is UNIQUE-indexed in the live catalog, so an orgNr-bearing
 * selector resolves deterministically to exactly one row — this is why every
 * pair below is expressed by org.nr rather than a hardcoded provider_id: it
 * is exactly as unambiguous, and it re-resolves correctly against the LIVE
 * catalog at call time the same way the rest of this file already does,
 * rather than trusting a point-in-time id snapshot). Every org.nr pair here
 * was cross-checked against the live catalog (gardssalg-provider-dedup-audit
 * and gardssalg-provider-lookup, both read-only) at authoring time — see the
 * PR description for per-row confidence notes.
 */
export const GS_ROUND2_TERMINAL_ITEMS: GsRound2TerminalItem[] = [
  {
    key: "simple-spotting",
    label: "Simple Spotting (holding) — terminal-mark, twin_link → Fjording AS",
    source: { orgNr: "913665406", nameHint: "Simple Spotting" },
    operating: { orgNr: "819708312", nameHint: "Fjording" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Simple Spotting 913665406, operativ drift i Fjording AS 819708312",
  },
  {
    key: "svalbard-distillery",
    label: "Svalbard Distillery (holding) — terminal-mark, twin_link → Svalbard Bryggeri AS",
    source: { nameHint: "Svalbard Distillery" },
    operating: { orgNr: "919176547", nameHint: "Svalbard Bryggeri" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Svalbard Distillery, operativ drift i Svalbard Bryggeri AS 919176547",
  },
  {
    key: "geir-bakken",
    label: "Geir Bakken (person-holding) — terminal-mark, twin_link → Larvik Mikrobryggeri",
    source: { orgNr: "988986208", nameHint: "Geir Bakken" },
    operating: { orgNr: "996692132", nameHint: "Larvik Mikrobryggeri" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr (personlig holding): Geir Bakken 988986208, operativ drift i Larvik Mikrobryggeri 996692132",
  },
  {
    key: "erik-juel-karlsen-eid",
    label: "Erik Juel Karlsen Eid (holding) — terminal-mark, twin_link → Norumbryggeriet AS",
    source: { orgNr: "992114231", nameHint: "Erik Juel Karlsen" },
    operating: { orgNr: "915132782", nameHint: "Norumbryggeriet" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Erik Juel Karlsen Eid 992114231, operativ drift i Norumbryggeriet AS 915132782",
  },
  {
    key: "ale-mates",
    label: "Ale Mates (holding) — terminal-mark, twin_link → Qvart & Homborsund",
    source: { orgNr: "918786309", nameHint: "Ale Mates" },
    operating: { orgNr: "918844201", nameHint: "Qvart & Homborsund" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Ale Mates 918786309, operativ drift i Qvart & Homborsund 918844201",
  },
  {
    key: "tradish-holding",
    label: "Tradish Holding — terminal-mark, twin_link → Tradish Brewing",
    source: { orgNr: "935230187", nameHint: "Tradish Holding" },
    operating: { orgNr: "935448239", nameHint: "Tradish Brewing" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Tradish Holding 935230187, operativ drift i Tradish Brewing 935448239",
  },
  {
    key: "guajiro-holding",
    label: "Guajiro Holding — terminal-mark, twin_link → Guajiro Gårdsdrift",
    source: { orgNr: "924944870", nameHint: "Guajiro Holding" },
    operating: { orgNr: "932165422", nameHint: "Guajiro Gårdsdrift" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Guajiro Holding 924944870, operativ drift i Guajiro Gårdsdrift 932165422",
  },
  {
    key: "lutlaget-jaastad",
    label: "Lutlaget Jaastad — terminal-mark, twin_link → Jaastad Sideri",
    source: { orgNr: "932568047", nameHint: "Lutlaget Jaastad" },
    operating: { orgNr: "932849429", nameHint: "Jaastad Sideri" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Lutlaget Jaastad 932568047, operativ drift i Jaastad Sideri 932849429",
  },
  {
    key: "monkey-businessmen",
    label: "Monkey Businessmen — terminal-mark, twin_link → Monkey Brew AS",
    source: { orgNr: "914918227", nameHint: "Monkey Businessmen" },
    operating: { orgNr: "917417997", nameHint: "Monkey Brew" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Monkey Businessmen 914918227, operativ drift i Monkey Brew AS 917417997",
  },
  {
    key: "ringnes-norge",
    label: "Ringnes Norge — terminal-mark, twin_link → Ringnes AS (data remap only — outreach-pool inclusion untouched)",
    source: { orgNr: "989668137", nameHint: "Ringnes Norge" },
    operating: { orgNr: "914670705", nameHint: "Ringnes AS" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note:
      "holding drift i annet org.nr (storkonsern, DATA REMAP ONLY — outreach-pool inclusion is a separate, " +
      "still-open Daniel decision, untouched here): Ringnes Norge 989668137, operativ drift i Ringnes AS 914670705",
  },
  {
    key: "arcus-loiten",
    label: "Løiten — terminal-mark, twin_link → Arcus Norway",
    source: { orgNr: "981940776", nameHint: "Løiten" },
    operating: { orgNr: "975381722", nameHint: "Arcus Norway" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr (storkonsern): Løiten 981940776, operativ drift i Arcus Norway 975381722",
  },
  {
    key: "arcus-oplandske",
    label: "Oplandske — terminal-mark, twin_link → Arcus Norway",
    source: { orgNr: "981995880", nameHint: "Oplandske" },
    operating: { orgNr: "975381722", nameHint: "Arcus Norway" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr (storkonsern): Oplandske 981995880, operativ drift i Arcus Norway 975381722",
  },
  {
    key: "arcus-siemers",
    label: "Siemers — terminal-mark, twin_link → Arcus Norway",
    source: { orgNr: "981995856", nameHint: "Siemers" },
    operating: { orgNr: "975381722", nameHint: "Arcus Norway" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr (storkonsern): Siemers 981995856, operativ drift i Arcus Norway 975381722",
  },
  {
    key: "arcus-lysholm",
    label: "Lysholm — terminal-mark, twin_link → Arcus Norway",
    source: { orgNr: "881995832", nameHint: "Lysholm" },
    operating: { orgNr: "975381722", nameHint: "Arcus Norway" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr (storkonsern): Lysholm 881995832, operativ drift i Arcus Norway 975381722",
  },
  {
    key: "njot-aga-sideri",
    label: "Njot — terminal-mark, twin_link → Aga Sideri",
    source: { orgNr: "928791432", nameHint: "Njot" },
    operating: { orgNr: "933780929", nameHint: "Aga Sideri" },
    evidenceClass: "holding_drift_i_annet_orgnr",
    note: "holding drift i annet org.nr: Njot 928791432, operativ drift i Aga Sideri 933780929",
  },
  {
    // Del C part 2 — NOT a §4a holding at all (no operating row exists to
    // twin_link to); reuses this SAME terminal mechanism per the dev-
    // request's own instruction ("same shape, different evidence class, no
    // twin_link"). org.nr 987141662 was deleted (slettet) in 2024 per fresh
    // Brreg research — this is the correct end-state, NOT a backfill target
    // (the independent §4e attempt for this same row, GS_4E_ITEMS below,
    // is expected to find no_brreg_candidate/backfilled_vetoed, which is
    // itself the correct, honestly-reported outcome, not a bug).
    key: "telemark-bryggeri",
    label: "Telemark Bryggeri AS — org.nr slettet 2024, terminal-mark (no operating row / no twin_link)",
    source: { orgNr: "987141662", nameHint: "Telemark Bryggeri AS" },
    evidenceClass: "brreg_slettet",
    note: "org.nr 987141662 slettet i Brønnøysundregistrene 2024 — ingen Brreg-kandidat, ingen operativ rad å twin_linke til",
  },
];

function processGsRound2TerminalItem(db: Database.Database, item: GsRound2TerminalItem, ctx: Ctx): GsDrikkelisteRowResult[] {
  const results: GsDrikkelisteRowResult[] = [];

  const { row: sourceRow, reason: unresolvedReason } = resolveGs4aSource(db, item.source, ctx.claimed, item.operating?.nameHint);
  if (!sourceRow) {
    results.push({
      category: "4a",
      key: item.key,
      label: item.label,
      method: "none",
      outcome: "unresolved",
      reason: unresolvedReason ?? "source_not_found",
    });
    return results;
  }
  ctx.claimed.add(sourceRow.id);

  const evidenceReason = `§4a round2 evidence_class=${item.evidenceClass}: ${item.label} — ${item.note}`;

  if (sourceRow.terminal_status === "dod_kilde") {
    results.push({
      category: "4a",
      key: item.key,
      label: item.label,
      method: "terminal_status",
      provider_id: sourceRow.id,
      outcome: "already_terminal",
      reason: evidenceReason,
    });
  } else if (ctx.apply) {
    const r = applyGardssalgSetTerminalStatus(sourceRow.id, "dod_kilde", evidenceReason, undefined);
    results.push({
      category: "4a",
      key: item.key,
      label: item.label,
      method: "terminal_status",
      provider_id: sourceRow.id,
      outcome: r.ok ? "terminal_marked" : "error",
      old_value: r.ok ? r.old_value : undefined,
      new_value: r.ok ? r.new_value : undefined,
      reason: r.ok ? evidenceReason : r.reason,
    });
  } else {
    results.push({
      category: "4a",
      key: item.key,
      label: item.label,
      method: "terminal_status",
      provider_id: sourceRow.id,
      outcome: "would_terminal_mark",
      old_value: sourceRow.terminal_status,
      new_value: "dod_kilde",
      reason: evidenceReason,
    });
  }

  if (!item.operating) return results;

  const operatingRow = resolveGs4aTarget(db, item.operating, ctx);
  if (!operatingRow) {
    results.push({
      category: "4a",
      key: item.key,
      label: item.label,
      method: "twin_link",
      provider_id: sourceRow.id,
      outcome: "unresolved",
      reason: "operating_not_found",
    });
    return results;
  }

  const alreadyLinked = twinLinkAlreadyRecorded(db, sourceRow.id, operatingRow.id);
  if (ctx.apply && !alreadyLinked) {
    insertTwinLinkAudit(db, sourceRow.id, operatingRow.id, ctx.batchId, evidenceReason);
  }
  results.push({
    category: "4a",
    key: item.key,
    label: item.label,
    method: "twin_link",
    provider_id: sourceRow.id,
    new_value: operatingRow.id,
    outcome: alreadyLinked ? "already_twin_linked" : ctx.apply ? "twin_linked" : "would_twin_link",
    reason: evidenceReason,
  });

  return results;
}

// ── §4b — dod_kilde terminal-mark ────────────────────────────────────────

type Gs4bCategory =
  | "konkursbo_kbo"
  | "brreg_slettet"
  | "nuf_uten_norsk_drift"
  | "omdopt_annet_formaal"
  | "forening_feil_nace"
  | "hobbyreg_uten_driftsspor"
  | "investeringsholding_uten_drift";

interface Gs4bItem {
  key: string;
  orgNr: string;
  label: string;
  category: Gs4bCategory;
  note?: string;
}

export const GS_4B_ITEMS: Gs4bItem[] = [
  { key: "st-hallvards-sa", orgNr: "936739547", label: "St.Hallvards SA", category: "konkursbo_kbo" },
  { key: "granskauen", orgNr: "935710073", label: "Granskauen", category: "konkursbo_kbo" },
  {
    key: "vestavin",
    orgNr: "937022700",
    label: "Vestavin",
    category: "konkursbo_kbo",
    note: "already adopted under Ystebakken 937441290 — skip re-processing if already terminal/merged, but still verify",
  },
  { key: "central-bybryggeri", orgNr: "935430119", label: "Central Bybryggeri", category: "konkursbo_kbo" },
  { key: "beer-flag", orgNr: "933586405", label: "Beer Flag", category: "konkursbo_kbo" },
  { key: "yeastside", orgNr: "837395402", label: "Yeastside", category: "konkursbo_kbo" },

  {
    key: "telemark-bryggeri",
    orgNr: "987141662",
    label: "Telemark Bryggeri AS",
    category: "brreg_slettet",
    note: "ALSO needs org.nr backfilled per §4e — independent field, both done",
  },

  { key: "azienda-nervi", orgNr: "915137512", label: "Azienda Nervi", category: "nuf_uten_norsk_drift" },
  { key: "carlsberg-breweries", orgNr: "984354568", label: "Carlsberg Breweries", category: "nuf_uten_norsk_drift" },
  { key: "fritt-fall-ltd", orgNr: "994336525", label: "Fritt Fall Ltd", category: "nuf_uten_norsk_drift" },

  { key: "kystgeita", orgNr: "833364642", label: "Kystgeita", category: "omdopt_annet_formaal" },
  { key: "skalleknarpen", orgNr: "956558387", label: "Skalleknarpen", category: "omdopt_annet_formaal" },

  { key: "bull-balls-brewery", orgNr: "927141957", label: "Bull Balls' Brewery", category: "forening_feil_nace" },
  { key: "glohanin", orgNr: "927587033", label: "Glohanin", category: "forening_feil_nace" },
  { key: "punsvik-skogsvegforening", orgNr: "871127832", label: "Punsvik Skogsvegforening", category: "forening_feil_nace" },
  { key: "hatlestrand-skogveglag", orgNr: "969318717", label: "Hatlestrand Skogveglag", category: "forening_feil_nace" },
  { key: "hemsedal-elveeigarlag", orgNr: "969553058", label: "Hemsedal Elveeigarlag", category: "forening_feil_nace" },
  { key: "svartlarskildteigen", orgNr: "969108917", label: "Svartlarskildteigen", category: "forening_feil_nace" },
  { key: "visit-nesna", orgNr: "921600666", label: "Visit Nesna", category: "forening_feil_nace" },
  { key: "everything-counts", orgNr: "913762290", label: "Everything Counts", category: "forening_feil_nace" },

  { key: "heimebrent", orgNr: "911600447", label: "Heimebrent", category: "hobbyreg_uten_driftsspor" },
  { key: "sandvins", orgNr: "929611470", label: "Sandvins", category: "hobbyreg_uten_driftsspor" },
  { key: "sogn-vineri-jan-fjell", orgNr: "925871451", label: "Sogn Vineri Jan Fjell", category: "hobbyreg_uten_driftsspor" },
  { key: "mark-ellenbogen", orgNr: "921525095", label: "Mark Ellenbogen", category: "hobbyreg_uten_driftsspor" },
  { key: "vinbonde-simon-oien", orgNr: "926366432", label: "Vinbonde Simon Øien", category: "hobbyreg_uten_driftsspor" },
  { key: "nerd-brew", orgNr: "825235612", label: "Nerd Brew", category: "hobbyreg_uten_driftsspor" },
  { key: "oddenbrygg", orgNr: "929665759", label: "Oddenbrygg", category: "hobbyreg_uten_driftsspor" },
  { key: "beergan", orgNr: "929059964", label: "Beergan", category: "hobbyreg_uten_driftsspor" },
  { key: "roberg-consulting", orgNr: "923235949", label: "Roberg Consulting", category: "hobbyreg_uten_driftsspor" },
  { key: "mostad", orgNr: "926697358", label: "Mostad", category: "hobbyreg_uten_driftsspor" },
  { key: "opedal-chu-hi", orgNr: "931725149", label: "Opedal Chu-Hi", category: "hobbyreg_uten_driftsspor" },
  { key: "kaupanger-vingard", orgNr: "985068453", label: "Kaupanger Vingard", category: "hobbyreg_uten_driftsspor" },
  { key: "fjord-whisky", orgNr: "926448870", label: "Fjord Whisky", category: "hobbyreg_uten_driftsspor" },
  { key: "nfh", orgNr: "934948297", label: "NFH", category: "hobbyreg_uten_driftsspor" },

  { key: "lavi-invest", orgNr: "927993384", label: "Lavi Invest", category: "investeringsholding_uten_drift" },
  { key: "libeto-holding", orgNr: "913832701", label: "Libeto Holding", category: "investeringsholding_uten_drift" },
  { key: "blue-hour-holding", orgNr: "930104647", label: "Blue Hour Holding", category: "investeringsholding_uten_drift" },
  { key: "marintech-invest", orgNr: "921087462", label: "Marintech Invest", category: "investeringsholding_uten_drift" },
  {
    key: "fortuna-bryggeri-holding",
    orgNr: "916160976",
    label: "Fortuna Bryggeri Holding",
    category: "investeringsholding_uten_drift",
  },
  {
    key: "malstraum",
    orgNr: "918544720",
    label: "Malstraum",
    category: "investeringsholding_uten_drift",
    note: "part of Kinn structure (cf. Kinn Bryggeri 918720065) but no confirmed operating org.nr — terminal-mark, don't remap",
  },
];

function processGs4bItem(db: Database.Database, item: Gs4bItem, ctx: Ctx): GsDrikkelisteRowResult {
  let row = findByOrgNr(db, item.orgNr);
  if (!row) {
    // Two distinct reasons org.nr lookup can miss, both legitimate, neither
    // a guess: (1) Vestavin-shaped — an earlier merge already cleared this
    // org.nr off the row (merge MOVES org.nr, never leaves it duplicated —
    // see gardssalg-provider-merge.ts); (2) Telemark-Bryggeri-shaped — the
    // row's org.nr genuinely isn't set YET (this is exactly the row §4e is
    // independently backfilling), so it can only be found by name. Name
    // lookup here INCLUDES already-merged rows so case (1) is reported
    // honestly instead of as a false unresolved; still requires an
    // UNAMBIGUOUS single match, same "don't guess" discipline as everywhere
    // else in this module.
    const candidates = findByNameContains(db, item.label, { includeMerged: true });
    if (candidates.length !== 1) {
      return { category: "4b", key: item.key, label: item.label, method: "none", outcome: "unresolved", reason: "source_not_found" };
    }
    if (candidates[0].merged_into) {
      return {
        category: "4b",
        key: item.key,
        label: item.label,
        method: "terminal_status",
        provider_id: candidates[0].id,
        outcome: "already_merged_skip",
        reason: item.note ?? `evidence_class=${item.category}`,
      };
    }
    row = candidates[0];
  }
  if (row.terminal_status === "dod_kilde") {
    return {
      category: "4b",
      key: item.key,
      label: item.label,
      method: "terminal_status",
      provider_id: row.id,
      outcome: "already_terminal",
      reason: item.note,
    };
  }
  const reason = `§4b ${item.category}: ${item.label} (${item.orgNr})${item.note ? " — " + item.note : ""}`;
  if (ctx.apply) {
    const r = applyGardssalgSetTerminalStatus(row.id, "dod_kilde", reason, undefined);
    return {
      category: "4b",
      key: item.key,
      label: item.label,
      method: "terminal_status",
      provider_id: row.id,
      outcome: r.ok ? "terminal_marked" : "error",
      old_value: r.ok ? r.old_value : undefined,
      new_value: r.ok ? r.new_value : undefined,
      reason: r.ok ? reason : r.reason,
    };
  }
  return {
    category: "4b",
    key: item.key,
    label: item.label,
    method: "terminal_status",
    provider_id: row.id,
    outcome: "would_terminal_mark",
    old_value: row.terminal_status,
    new_value: "dod_kilde",
    reason,
  };
}

// ── §4c — leftover duplicate pairs ───────────────────────────────────────

interface Gs4cItem {
  key: string;
  label: string;
  nameHint: string;
  ambiguousByDesign?: boolean;
  /**
   * Round-2 addition (dev-request 2026-08-30-drikkeliste-remediering-runde-2,
   * Del B): an explicit provider_id PAIR, checked before the name-based
   * lookup (and before the ambiguousByDesign short-circuit — a pair given
   * here means the ambiguity IS now resolved, so the by-design refusal no
   * longer applies). Which of the two survives is still decided by
   * pickSurvivor below exactly as for a name-resolved pair — providerIds
   * only replaces HOW the two candidate rows are found, never the
   * survivorship rule itself.
   */
  providerIds?: [string, string];
  note: string;
}

export const GS_4C_ITEMS: Gs4cItem[] = [
  { key: "grana-bryggeri", label: "Grana Bryggeri (duplicate pair)", nameHint: "Grana Bryggeri", note: "§4c duplicate pair" },
  {
    key: "halden-mikrobryggeri",
    label: "Halden Mikrobryggeri (duplicate pair)",
    nameHint: "Halden Mikrobryggeri",
    note: "§4c duplicate pair",
  },
  {
    key: "sognefjord-bryggeri",
    label: "Sognefjord Bryggeri (duplicate pair)",
    nameHint: "Sognefjord Bryggeri",
    note: "§4c duplicate pair",
  },
  {
    key: "druehagen",
    label: "Druehagen (duplicate pair)",
    nameHint: "Druehagen",
    // Round 2 Del B: exactly 2 live name matches today (Druehagen Gård /
    // Druehagen Drift) — resolved via providerIds for certainty even though
    // the plain name lookup below would independently agree.
    providerIds: ["59a17ff7-d786-4743-bb4f-56853d09233f", "f38c3280-25c3-4ed3-932b-0fc913a8bc9c"],
    note: "§4c duplicate pair",
  },
  { key: "torst", label: "Tørst (duplicate pair)", nameHint: "Tørst", note: "§4c duplicate pair" },
  {
    key: "fjellbryggeriet-leftover-pair",
    label: "Fjellbryggeriet leftover duplicate pair (DIFFERENT from the §4a DA→AS remap)",
    nameHint: "Fjellbryggeriet",
    ambiguousByDesign: true,
    // Round 2 Del B: the two rows left over after §4a's own Fjellbryggeriet
    // DA→AS merge already landed are now unambiguously identifiable live
    // (32fd77ac is that merge's own survivor — org_nr 916476450 — with a
    // second, still-separate blank-org_nr duplicate, 7d2bfb81) — providerIds
    // overrides the ambiguousByDesign refusal above.
    providerIds: ["7d2bfb81-41fc-41cb-b815-1f960e57c3fb", "32fd77ac-d490-4873-bbe7-650a64ae54f4"],
    note:
      "§4c leftover duplicate ROW pair, DIFFERENT from §4a's Fjellbryggeriet DA→AS holding remap — the name " +
      "collision makes which two rows this refers to genuinely ambiguous; reported unresolved BY DESIGN rather " +
      "than guessed (never even attempted against the live catalog)",
  },
];

function processGs4cItem(db: Database.Database, item: Gs4cItem, ctx: Ctx): GsDrikkelisteRowResult {
  if (item.providerIds) {
    const [idA, idB] = item.providerIds;
    const rowA = findById(db, idA);
    const rowB = findById(db, idB);
    if (!rowA || !rowB) {
      return {
        category: "4c",
        key: item.key,
        label: item.label,
        method: "none",
        outcome: "unresolved",
        reason: "provider_id_not_found",
      };
    }
    if (ctx.claimed.has(rowA.id) || ctx.claimed.has(rowB.id)) {
      return {
        category: "4c",
        key: item.key,
        label: item.label,
        method: "none",
        outcome: "unresolved",
        reason: "provider_id_already_claimed",
      };
    }
    const { keep, remove } = pickSurvivor(rowA, rowB);
    ctx.claimed.add(remove.id);
    ctx.claimed.add(keep.id);
    const mergeResult = ctx.apply
      ? applyGardssalgProviderMergePair(db, remove.id, keep.id, item.note, ctx.batchId)
      : previewGardssalgProviderMergePair(db, remove.id, keep.id);
    return {
      category: "4c",
      key: item.key,
      label: item.label,
      method: "merge",
      remove_id: remove.id,
      keep_id: keep.id,
      outcome: mergeResult.outcome,
      reason: mergeResult.reason ?? item.note,
    };
  }
  if (item.ambiguousByDesign) {
    return {
      category: "4c",
      key: item.key,
      label: item.label,
      method: "none",
      outcome: "unresolved",
      reason: "ambiguous_name_collision_with_4a_fjellbryggeriet_by_design",
    };
  }
  const candidates = findByNameContains(db, item.nameHint, { excludeIds: ctx.claimed });
  if (candidates.length !== 2) {
    return {
      category: "4c",
      key: item.key,
      label: item.label,
      method: "none",
      outcome: "unresolved",
      reason: `expected_2_rows_found_${candidates.length}`,
    };
  }
  const [a, b] = candidates;
  const { keep, remove } = pickSurvivor(a, b);
  ctx.claimed.add(remove.id);
  ctx.claimed.add(keep.id);
  const mergeResult = ctx.apply
    ? applyGardssalgProviderMergePair(db, remove.id, keep.id, item.note, ctx.batchId)
    : previewGardssalgProviderMergePair(db, remove.id, keep.id);
  return {
    category: "4c",
    key: item.key,
    label: item.label,
    method: "merge",
    remove_id: remove.id,
    keep_id: keep.id,
    outcome: mergeResult.outcome,
    reason: mergeResult.reason ?? item.note,
  };
}

// ── §4d — website corrections ────────────────────────────────────────────

interface Gs4dItem {
  key: string;
  label: string;
  resolveBy: "name" | "website";
  hint: string;
  newValue: string | null;
  /**
   * Round-2 addition (dev-request 2026-08-30-drikkeliste-remediering-runde-2,
   * Del B): explicit provider_id, checked before the resolveBy/hint lookup.
   * Same rationale as Gs4aSourceSelector.providerId above.
   */
  providerId?: string;
  note: string;
}

export const GS_4D_ITEMS: Gs4dItem[] = [
  {
    key: "norstill",
    label: "Norstill",
    resolveBy: "name",
    hint: "Norstill",
    newValue: null,
    note: "§4d: stored site is the trade association's (norskedestillerier.no) — null it",
  },
  {
    key: "myken-destilleri",
    label: "Myken Destilleri",
    resolveBy: "name",
    hint: "Myken Destilleri",
    newValue: "https://mykendistillery.com",
    note: "§4d: corrected to mykendistillery.com",
  },
  {
    key: "vingaarden-nr20",
    label: "Vingården (\"nr20\")",
    resolveBy: "website",
    hint: "spornes.no",
    newValue: null,
    note: "§4d: Vingården (\"nr20\", no stable id given in the report) — stored spornes.no doesn't match — null it",
  },
  {
    key: "ulvik-frukt-cideri",
    label: "Ulvik Frukt & Cideri",
    resolveBy: "name",
    hint: "Ulvik Frukt",
    // Round 2 Del B: "Ulvik Frukt" name-matches 3 live rows — resolved via
    // providerId instead, cross-checked against the WRONG stored site itself
    // (a providers/by-hjemmeside lookup for "aldesider.no" returns exactly
    // this one row) — the strongest possible confirmation for this specific
    // correction (the row IS the one carrying the wrong site to be nulled).
    providerId: "5fda0eed-f7ba-4653-b663-0f33345ce942",
    newValue: null,
    note: "§4d: stored aldesider.no belongs to a different producer — null it",
  },
  {
    key: "raaen",
    label: "Raaen",
    resolveBy: "name",
    hint: "Raaen",
    newValue: null,
    note: "§4d dead site (DNS-dead): funnet død — null it",
  },
  {
    key: "alvavoll",
    label: "Alvavoll",
    resolveBy: "name",
    hint: "Alvavoll",
    newValue: null,
    note: "§4d dead site (parked): funnet død — null it",
  },
  {
    key: "marlobobo",
    label: "Marlobobo.no",
    resolveBy: "website",
    hint: "marlobobo.no",
    // Round 2 Del B: the live row's hjemmeside no longer contains
    // "marlobobo" at all (by-hjemmeside now returns zero matches — likely
    // already partially cleared or reformatted since the report was
    // written), so the website-substring lookup this item was designed
    // around no longer finds it. It IS still the sole live name match for
    // "Marlobobo" catalog-wide ("Marlobobos") — resolved via providerId on
    // that basis.
    providerId: "b66d6bf7-67c8-4726-b765-f5a35fdab622",
    newValue: null,
    note: "§4d dead site (expired): funnet død — null it",
  },
  {
    key: "skifjorden-website",
    label: "skifjorden.no (dead site — NOT the §4a Skifjorden coop twin-link row)",
    resolveBy: "website",
    hint: "skifjorden.no",
    newValue: null,
    note:
      "§4d dead site (expired): funnet død — null it. DIFFERENT row from the §4a Skifjorden COOP twin-link " +
      "entry; that row is never touched here",
  },
  {
    key: "skjolden-sideri",
    label: "Skjolden Sideri",
    resolveBy: "name",
    hint: "Skjolden Sideri",
    newValue: null,
    note: "§4d dead site (password-locked): funnet død — null it",
  },
];

function processGs4dItemWithCtx(db: Database.Database, item: Gs4dItem, ctx: Ctx): GsDrikkelisteRowResult {
  let row: ProviderSnapshot | null;
  if (item.providerId) {
    row = findById(db, item.providerId);
    if (!row) {
      return {
        category: "4d",
        key: item.key,
        label: item.label,
        method: "none",
        outcome: "unresolved",
        reason: "provider_id_not_found",
      };
    }
  } else {
    const candidates = item.resolveBy === "name" ? findByNameContains(db, item.hint, {}) : findByWebsiteContains(db, item.hint);
    if (candidates.length !== 1) {
      return {
        category: "4d",
        key: item.key,
        label: item.label,
        method: "none",
        outcome: "unresolved",
        reason: `expected_1_row_found_${candidates.length}`,
      };
    }
    row = candidates[0];
  }
  if (ctx.apply) {
    const r = applyGardssalgSetHjemmeside(row.id, item.newValue, item.note, undefined);
    return {
      category: "4d",
      key: item.key,
      label: item.label,
      method: "hjemmeside",
      provider_id: row.id,
      outcome: r.ok ? "hjemmeside_corrected" : "error",
      old_value: r.ok ? r.old_value : undefined,
      new_value: r.ok ? r.new_value : undefined,
      reason: r.ok ? item.note : r.reason,
    };
  }
  return {
    category: "4d",
    key: item.key,
    label: item.label,
    method: "hjemmeside",
    provider_id: row.id,
    outcome: "would_correct_hjemmeside",
    old_value: row.hjemmeside,
    new_value: item.newValue,
    reason: item.note,
  };
}

// ── §4e — missing org.nr backfill (cross-checked) ────────────────────────

interface Gs4eItem {
  key: string;
  label: string;
  nameHint: string;
  expectedOrgNr: string;
  /**
   * Round-2 addition (dev-request 2026-08-30-drikkeliste-remediering-runde-2,
   * Del B): explicit provider_id, checked before the exact-1-name-match
   * lookup. Same rationale as Gs4aSourceSelector.providerId above.
   */
  providerId?: string;
  note: string;
}

export const GS_4E_ITEMS: Gs4eItem[] = [
  {
    key: "killi-mikrobryggeri",
    label: "Killi Mikrobryggeri",
    nameHint: "Killi Mikrobryggeri",
    expectedOrgNr: "924960884",
    // Round 2 Del B: "Killi Mikrobryggeri" name-matches 2 live rows (round 1
    // expected exactly 1). The other match already carries org_nr 924960884
    // (this item's own expected value) — this row is its blank-org_nr
    // duplicate in the SAME live dedup-audit group, so it is the one
    // genuinely missing the backfill.
    providerId: "8abf2877-a5c0-4acb-8089-5105d627aa90",
    note: "§4e",
  },
  { key: "fossmoen-frukt", label: "Fossmoen Frukt", nameHint: "Fossmoen Frukt", expectedOrgNr: "986427538", note: "§4e" },
  {
    key: "hunsfos-bryggeri",
    label: "Hunsfos Bryggeri",
    nameHint: "Hunsfos Bryggeri",
    expectedOrgNr: "913052803",
    // Round 2 Del B: same shape as Killi above — 2 live name matches, the
    // sibling row already carries this item's expected org_nr.
    providerId: "1c43bbdb-0434-468f-9bb6-dab89e76ad16",
    note: "§4e",
  },
  {
    key: "trondhjem-mikrobryggeri",
    label: "Trondhjem Mikrobryggeri",
    nameHint: "Trondhjem Mikrobryggeri",
    expectedOrgNr: "979740360",
    // Round 2 Del B: 4 live name matches (round 1 expected exactly 1). Two
    // are excluded from the live dedup-audit's grouping entirely (distinct
    // spelling/legal-form variants, recognised as separate entities); of the
    // remaining two, one already carries this item's expected org_nr and the
    // other is its blank-org_nr dedup-grouped duplicate — that one is this id.
    providerId: "0995b7f3-8fc7-4ff1-9b0b-612e5fa31ed2",
    note: "§4e",
  },
  {
    key: "hardanger-handbryggeri",
    label: "Hardanger Handbryggeri",
    nameHint: "Hardanger Handbryggeri",
    expectedOrgNr: "915218857",
    note: "§4e (same row as §4a's cross-referenced backfill note — done once, here)",
  },
  {
    key: "telemark-bryggeri",
    label: "Telemark Bryggeri",
    nameHint: "Telemark Bryggeri",
    expectedOrgNr: "987141662",
    note: "§4e (same row as §4b's brreg_slettet mark — independent fields, both done)",
  },
];

/** Injected caller for the EXISTING POST /admin/gardssalg-orgnr-backfill route, called in-process by the HTTP layer (avoids a circular import between this service module and routes/opplevelser.ts). */
export type GardssalgOrgnrBackfillCaller = (providerIds: string[], apply: boolean) => Promise<{ status: number; body: any }>;

async function processGs4eItem(
  db: Database.Database,
  item: Gs4eItem,
  ctx: { apply: boolean; callBackfill: GardssalgOrgnrBackfillCaller },
): Promise<GsDrikkelisteRowResult> {
  let row: ProviderSnapshot | null;
  if (item.providerId) {
    row = findById(db, item.providerId);
    if (!row) {
      return {
        category: "4e",
        key: item.key,
        label: item.label,
        method: "none",
        outcome: "unresolved",
        expected_value: item.expectedOrgNr,
        reason: "provider_id_not_found",
      };
    }
  } else {
    const candidates = findByNameContains(db, item.nameHint, {});
    if (candidates.length !== 1) {
      return {
        category: "4e",
        key: item.key,
        label: item.label,
        method: "none",
        outcome: "unresolved",
        expected_value: item.expectedOrgNr,
        reason: `expected_1_row_found_${candidates.length}`,
      };
    }
    row = candidates[0];
  }
  if (row.org_nr && row.org_nr.trim()) {
    return {
      category: "4e",
      key: item.key,
      label: item.label,
      method: "orgnr_backfill",
      provider_id: row.id,
      outcome: "already_filled",
      old_value: row.org_nr,
      expected_value: item.expectedOrgNr,
      reason: row.org_nr === item.expectedOrgNr ? undefined : "already_filled_value_differs_from_report",
    };
  }

  const resp = await ctx.callBackfill([row.id], ctx.apply);
  const changed = ((resp.body?.changed ?? []) as any[]).find((c) => c.provider_id === row.id);
  const unresolved = ((resp.body?.unresolved ?? []) as any[]).find((u) => u.provider_id === row.id);

  if (changed) {
    const matched = changed.org_nr === item.expectedOrgNr;
    return {
      category: "4e",
      key: item.key,
      label: item.label,
      method: "orgnr_backfill",
      provider_id: row.id,
      outcome: matched ? (ctx.apply ? "backfilled_match" : "would_backfill_match") : "backfilled_mismatch",
      old_value: null,
      new_value: changed.org_nr,
      expected_value: item.expectedOrgNr,
      reason: matched ? item.note : `route_resolved_${changed.org_nr}_report_expected_${item.expectedOrgNr}`,
    };
  }
  if (unresolved) {
    return {
      category: "4e",
      key: item.key,
      label: item.label,
      method: "orgnr_backfill",
      provider_id: row.id,
      outcome: "backfilled_vetoed",
      expected_value: item.expectedOrgNr,
      reason: unresolved.reason,
    };
  }
  return {
    category: "4e",
    key: item.key,
    label: item.label,
    method: "orgnr_backfill",
    provider_id: row.id,
    outcome: "unresolved",
    expected_value: item.expectedOrgNr,
    reason: "backfill_route_no_result",
  };
}

// ── §4e round 2 — postal-code data-input fix for a previously-vetoed backfill ─
//
// dev-request 2026-08-30-drikkeliste-remediering-runde-2, Del C part 1
// (daniel_authorized). §4e's org.nr-backfill route (POST /admin/gardssalg-
// orgnr-backfill) vetoes any candidate that fails gardssalgOrgnrPostalCorroborated
// (experience-store.ts) — that gate compares the PROVIDER ROW'S OWN stored
// postnummer/poststed against the Brreg candidate's postal fields, never a
// caller-supplied value, so a row with a blank postnummer/poststed can never
// pass it (per Daniel's "ved tvil: ikke skriv" — there being nothing to
// corroborate against is treated as no corroboration, not a free pass). This
// confirms the fix Daniel authorized IS a data-input fix, not a gate-logic
// change: hardanger-handbryggeri's postnummer/poststed are blank live today
// (its queued org_nr-review-queue entry was vetoed with reason
// "heuristic_name_requires_postal_match" — nothing to corroborate against),
// but fresh Brreg/proff research (2026-08-29) found its real forretnings-
// adresse (Børve, 5773 Hovland) — supplying THAT via the EXISTING fill-only
// address writer (applyGardssalgProviderAddress, experience-store.ts — the
// SAME lever §3's address-enrichment slice already uses; no new writer) gives
// the gate real data to check the next time §4e's backfill call runs for
// this row. Whether that then actually lands on the report's expected
// org.nr (915218857) is for §4e's own existing cross-check (GS_4E_ITEMS'
// hardanger-handbryggeri entry, unchanged) to report — this step's only job
// is supplying the correct postal input, never re-deciding what counts as a
// match.
//
// Fill-only (applyGardssalgProviderAddress only ever writes a currently-BLANK
// field) — idempotent by construction: a second run against an
// already-filled row writes nothing further.

interface GsRound2PostalPrefillItem {
  key: string;
  label: string;
  providerId: string;
  adresse?: string;
  postnummer: string;
  poststed: string;
  note: string;
}

export const GS_ROUND2_POSTAL_PREFILL_ITEMS: GsRound2PostalPrefillItem[] = [
  {
    key: "hardanger-handbryggeri-postal",
    label: "Hardanger Handbryggeri — postal data-input fix for the vetoed §4e backfill",
    providerId: "8c2e422c-2d40-45c2-ba61-588faac2755a",
    adresse: "Børve",
    postnummer: "5773",
    poststed: "Hovland",
    note:
      "round2 Del C: forretningsadresse Børve, 5773 Hovland per fresh Brreg/proff research 2026-08-29 — " +
      "supplies the postal-corroboration gate's missing input for the org.nr 915218857 backfill",
  },
];

function processGsRound2PostalPrefillItem(
  db: Database.Database,
  item: GsRound2PostalPrefillItem,
  ctx: { apply: boolean; batchId: string },
): GsDrikkelisteRowResult {
  const row = findById(db, item.providerId);
  if (!row) {
    return {
      category: "4e",
      key: item.key,
      label: item.label,
      method: "none",
      outcome: "unresolved",
      reason: "provider_id_not_found",
    };
  }
  const evidenceUrl = `${GS_DRIKKELISTE_REMEDIATION_MARKER}#round2-postal-prefill`;
  if (!ctx.apply) {
    return {
      category: "4e",
      key: item.key,
      label: item.label,
      method: "none",
      provider_id: row.id,
      outcome: "would_postal_prefill",
      new_value: `${item.adresse ?? ""}, ${item.postnummer} ${item.poststed}`.trim(),
      reason: item.note,
    };
  }
  const written = applyGardssalgProviderAddress(
    item.providerId,
    { adresse: item.adresse, postnummer: item.postnummer, poststed: item.poststed },
    evidenceUrl,
    ctx.batchId,
  );
  return {
    category: "4e",
    key: item.key,
    label: item.label,
    method: "none",
    provider_id: item.providerId,
    outcome: written.length > 0 ? "postal_prefilled" : "already_filled",
    new_value: written.length > 0 ? written.join(",") : undefined,
    reason: item.note,
  };
}

// ── Top-level orchestrator ───────────────────────────────────────────────

export interface GardssalgDrikkelisteRemediationReport {
  success: true;
  dry_run: boolean;
  batch_id: string;
  before_count: number;
  after_count: number;
  summary: {
    total: number;
    by_outcome: Record<string, number>;
    by_category: Record<string, { total: number; by_outcome: Record<string, number> }>;
  };
  results: GsDrikkelisteRowResult[];
  unresolved: GsDrikkelisteRowResult[];
}

const NOTEWORTHY_OUTCOMES = new Set(["unresolved", "rejected", "error", "backfilled_mismatch", "backfilled_vetoed"]);

export async function runGardssalgDrikkelisteRemediation(
  db: Database.Database,
  opts: { apply: boolean; batchId?: string; callBackfill: GardssalgOrgnrBackfillCaller },
): Promise<GardssalgDrikkelisteRemediationReport> {
  const apply = opts.apply;
  const batchId =
    opts.batchId && opts.batchId.trim()
      ? opts.batchId.trim()
      : `drikkeliste-remediation-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const beforeCount = (db.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;

  const ctx: Ctx = { apply, batchId, claimed: new Set<string>(), virtualOrgNrMap: new Map<string, string>() };

  const results: GsDrikkelisteRowResult[] = [];
  for (const item of GS_4A_ITEMS) results.push(...processGs4aItem(db, item, ctx));
  // Round 2 Del A + Del C part 2 — runs right after §4a proper (same
  // category, same "holding/dead-source, terminal-mark instead of merge"
  // shape) and BEFORE §4b, so Telemark Bryggeri's §4b entry below sees an
  // already-terminal row on the very same run (already_terminal, no
  // duplicate write) rather than racing it — both entries targeting the
  // same row is intentional (see GS_ROUND2_TERMINAL_ITEMS' own doc comment).
  for (const item of GS_ROUND2_TERMINAL_ITEMS) results.push(...processGsRound2TerminalItem(db, item, ctx));
  for (const item of GS_4B_ITEMS) results.push(processGs4bItem(db, item, ctx));
  for (const item of GS_4C_ITEMS) results.push(processGs4cItem(db, item, ctx));
  for (const item of GS_4D_ITEMS) results.push(processGs4dItemWithCtx(db, item, ctx));
  // Round 2 Del C part 1 — runs BEFORE §4e proper so hardanger-handbryggeri's
  // postal fields are already filled (under apply) by the time §4e's own
  // backfill call for that same row runs later in this loop.
  for (const item of GS_ROUND2_POSTAL_PREFILL_ITEMS) results.push(processGsRound2PostalPrefillItem(db, item, ctx));
  for (const item of GS_4E_ITEMS) results.push(await processGs4eItem(db, item, { apply, callBackfill: opts.callBackfill }));

  const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;

  const byOutcome: Record<string, number> = {};
  const byCategory: Record<string, { total: number; by_outcome: Record<string, number> }> = {};
  for (const r of results) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    if (!byCategory[r.category]) byCategory[r.category] = { total: 0, by_outcome: {} };
    byCategory[r.category].total++;
    byCategory[r.category].by_outcome[r.outcome] = (byCategory[r.category].by_outcome[r.outcome] ?? 0) + 1;
  }

  const unresolved = results.filter((r) => NOTEWORTHY_OUTCOMES.has(r.outcome));

  return {
    success: true,
    dry_run: !apply,
    batch_id: batchId,
    before_count: beforeCount,
    after_count: afterCount,
    summary: { total: results.length, by_outcome: byOutcome, by_category: byCategory },
    results,
    unresolved,
  };
}
