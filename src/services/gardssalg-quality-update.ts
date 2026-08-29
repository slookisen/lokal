// ─── Gårdssalg content QUALITY-UPDATE lever (dev-request 2026-08-17-
// forsyningskjede-samarbeid-og-kvalitetsoppdatering, Skive 3 — "erstatter
// fill-only") ────────────────────────────────────────────────────────────
//
// Daniel, live session 2026-08-17 (ordrett, see the dev-request's own header
// for the full quote): "en dårlig beskrivelse skal kunne endres med en mer
// komplett og bedre beskrivelse ... Riktig info skal kunne byttes med feil
// info ... Det eneste unntaket er dersom profilen er tatt over av en eier ...
// da skal feltene sperres ... med mindre eier spesifikt ber oss om det."
//
// Every gårdssalg content writer in this codebase up to this dev-request is
// FILL-ONLY for about_text/visit_text/opening_hours_text once a field is
// non-blank (opening_hours_text always was; about_text/visit_text got a
// narrow "replace-thin-or-contaminated" carve-out via
// gardssalgReplaceableFieldAction — see experience-store.ts — but that never
// covers opening_hours_text, and its "current passes the cheap bar" escape
// hatch is exactly what let the Bringebærlandet defect below survive every
// prior pass). This module is the POLICY this dev-request adds: a candidate
// may replace an EXISTING non-blank value, but only when it is *measurably*
// better — never merely newer, never overriding an owner's own edit.
//
// Three independent pieces, in the order a caller should apply them:
//   A. Owner-lock (isGardssalgFieldOwnerLocked, already shipped — this
//      module does NOT re-implement it, only consumes it) — absolute, and
//      the FIRST gate a caller must check, before any of the logic below
//      even runs. See applyGardssalgQualityReplacement's own re-check.
//   B/C. classifyGardssalgFieldDefect + countGardssalgInfoPoints, composed
//      by planGardssalgFieldReplacement — the PURE "should this candidate
//      replace this current value" decision. No DB, no network.
//   D. checkGardssalgAntiChurn — the only DB-touching read in this module
//      besides the writer itself: same (provider_id, field_name) pair
//      replaced at most once per GARDSSALG_QUALITY_ANTI_CHURN_DAYS days,
//      unless the source page's content actually changed since.
//   E. applyGardssalgQualityReplacement — the writer. Re-verifies A/B-C/D
//      against a FRESH row read inside its own transaction (defense in
//      depth, same discipline as applyGardssalgProviderMergePair's
//      evaluatePair — see gardssalg-provider-merge.ts), then writes the
//      field + merges field_provenance (read-modify-write, never clobbers
//      other fields' entries — same convention applyGardssalgProviderContent
//      uses) + inserts exactly ONE gardssalg_content_audit row, in the SAME
//      shape (id, provider_id, field_name, old_value, new_value, source_url,
//      batch_id, changed_by, changed_at, notes) every other gårdssalg writer
//      in this codebase already uses (see e.g. gardssalg-provider-merge.ts's
//      insertAuditRow or applyGardssalgRollbackVetoOverride,
//      experience-store.ts) — so the EXISTING POST /admin/gardssalg-content-
//      rollback endpoint (about_text/visit_text/opening_hours_text are
//      already in GARDSSALG_ROLLBACKABLE_FIELDS there) restores a
//      quality-update write with zero changes to that endpoint.
//
// The route (POST /admin/gardssalg-content-quality-update, routes/
// opplevelser.ts) owns candidate GENERATION (fetching the homepage, running
// summarizeAbout/summarizeVisit/extractOpeningHours + the SAME
// meetsGardssalgAboutQualityBar LLM-judge cascade content-refresh already
// uses for about_text/visit_text) — this module never fetches anything
// itself, so it stays trivially unit-testable.
import type Database from "better-sqlite3";
import { createHash } from "crypto";
import { v4 as uuid } from "uuid";
import { classifyAboutCheapBar } from "./search-enrich";
import { isGardssalgFieldOwnerLocked } from "./experience-store";

export type GardssalgQualityFieldName = "about_text" | "visit_text" | "opening_hours_text";

export const GARDSSALG_QUALITY_FIELDS: readonly GardssalgQualityFieldName[] = [
  "about_text",
  "visit_text",
  "opening_hours_text",
];

function isGardssalgQualityFieldName(v: unknown): v is GardssalgQualityFieldName {
  return typeof v === "string" && (GARDSSALG_QUALITY_FIELDS as readonly string[]).includes(v);
}

// ── B. Obvious-defect classifier ────────────────────────────────────────

export type GardssalgDefectType =
  | "too_short"
  | "placeholder"
  | "boilerplate"
  | "css_js_leakage"
  | "ui_chrome_leakage"
  | "truncated_mid_sentence"
  | "wrong_language"
  | "mangled_encoding"
  | "duplicate_of_other_provider";

export interface GardssalgDefectVerdict {
  defective: boolean;
  type: GardssalgDefectType | null;
}

// "Too short to be informative" floor — field-specific, since
// opening_hours_text is legitimately short by nature ("Lør-søn 10-16" is 15
// chars and perfectly fine) while about_text/visit_text are prose fields.
// 40 chars for prose is deliberately BELOW search-enrich.ts's
// meetsAboutCheapBar 80-char default: that 80-char bar decides whether a
// value is GOOD ENOUGH to stand as a fill/rewrite candidate; this 40-char
// floor decides whether a value is BAD ENOUGH to count as an objective
// defect worth overriding an owner-less row for. A 50-char current value is
// thin (never proactively replaces a decent value — that's what the margin
// check in C is for) but is not the Bringebærlandet-class defect B exists
// to catch. 8 chars for opening_hours_text rejects near-empty junk ("...",
// a single stray character) while leaving every real short hours string
// alone.
const GARDSSALG_QUALITY_MIN_CHARS: Record<GardssalgQualityFieldName, number> = {
  about_text: 40,
  visit_text: 40,
  opening_hours_text: 8,
};

// Mirrors the INTENT of search-enrich.ts's GENERIC_ABOUT_MARKERS (that list
// is module-private there, not exported, so it is not re-imported here) —
// split into two more specific lists so this classifier can report
// "placeholder" and "boilerplate"/cookie-notice as DISTINCT defect types
// (the dev-request calls both out by name as separate defect classes),
// rather than collapsing everything into one generic "boilerplate" bucket.
const GARDSSALG_PLACEHOLDER_MARKERS: readonly string[] = [
  "lorem ipsum",
  "coming soon",
  "kommer snart",
  "under construction",
  "under oppbygging",
  "siden er under",
  "todo",
  "placeholder",
];
const GARDSSALG_COOKIE_NOTICE_MARKERS: readonly string[] = [
  "cookie",
  "informasjonskapsler",
  "samtykke",
  "personvern",
];

// The dev-request's own concrete example (Bringebærlandet, ce85458a,
// opening_hours_text): literal slider-navigation-control text ("Previous
// Next") embedded MID-STRING in what is otherwise real prose. Norwegian
// ("forrige"/"neste") and a couple of common English variants included so
// this isn't a single-literal-string detector.
const GARDSSALG_UI_CHROME_RE =
  /\b(previous\s+next|forrige\s+neste|next\s+slide|prev(?:ious)?\s+slide|«\s*forrige|neste\s*»)\b/i;

// CSS/JS leakage: a raw style/script fragment glued into extracted text.
// Three independent signals (any one is sufficient) — deliberately layered
// rather than one giant regex, so each is independently testable/tunable:
//   1. a literal <style>/<script> tag survived text extraction,
//   2. a CSS rule shape: a selector (.class or #id) immediately followed by
//      a `{ ... }` block,
//   3. `!important` — essentially never appears in producer prose, always a
//      CSS leak,
//   4. a density signal: enough `{`/`}`/`;` punctuation relative to length
//      that this reads as code, not sentences (catches JS fragments that
//      don't match #2's CSS-selector shape, e.g. a bare `function(){...}`
//      block or a chain of `var x = ...;` statements).
function looksLikeCssOrJsLeakage(trimmed: string): boolean {
  if (/<\s*(style|script)[\s>]/i.test(trimmed)) return true;
  if (/[.#][a-zA-Z][\w-]*\s*\{[^{}]*\}/.test(trimmed)) return true;
  if (/!important/i.test(trimmed)) return true;
  const codePunct = (trimmed.match(/[{};]/g) ?? []).length;
  if (codePunct >= 3 && codePunct / trimmed.length > 0.02) return true;
  return false;
}

// "Cut off mid-sentence" heuristic — documented as imperfect (the dev-request
// explicitly only requires this be documented and tested, not perfect).
// Only evaluated on text long enough to plausibly BE a sentence/paragraph
// (short deliberate labels like "Åpent hele sommeren" must not
// false-positive just for lacking a period) — text ending in anything OTHER
// than closing punctuation is treated as truncated. This is a one-sided
// heuristic: it catches "...Vinmonopolet i Ås sine åpningstider (man, tirs,
// ons: 10-17 …). Previous Next Seks kilome" (ends "kilome", no closing
// punctuation) but will not catch every truncation (a cut that happens to
// land on a word ending in a real Norwegian word is indistinguishable from
// an intentional sentence fragment by this check alone).
const GARDSSALG_TRUNCATION_MIN_LEN = 50;
function looksTruncatedMidSentence(trimmed: string): boolean {
  if (trimmed.length < GARDSSALG_TRUNCATION_MIN_LEN) return false;
  return !/[.!?…»"'”\)\]]$/.test(trimmed);
}

function normalizeForDuplicateCompare(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Classify ONE current/candidate field value for an objective, no-judgment-
 * call defect (Skive 3-B). PURE — no DB, no network. `othersForField`
 * (optional) is every OTHER provider's current stored value for the SAME
 * field — pass it to enable the "identical to another (different)
 * provider's stored value" (template-leakage) check; omit it (or pass an
 * empty array) to skip that check, e.g. when classifying a freshly
 * extracted CANDIDATE that has no meaningful "other providers" comparison.
 *
 * Order matters only in that duplicate/UI-chrome/CSS-JS/placeholder/cookie
 * are checked before the length floor and the cheap-bar backstop — a value
 * long enough to clear the length floor can still carry any of those more
 * specific defects, and a specific, nameable defect is always a more useful
 * report than the generic "too_short" would be if it happened to also be
 * short. A real string practically never trips more than one of these in
 * practice; where it could (e.g. a short cookie-notice snippet), the more
 * specific defect type wins, which matches how this classifier is meant to
 * be read.
 */
export function classifyGardssalgFieldDefect(
  fieldName: GardssalgQualityFieldName,
  rawValue: string | null | undefined,
  options?: { othersForField?: readonly (string | null | undefined)[] }
): GardssalgDefectVerdict {
  const trimmed = (rawValue ?? "").trim();
  if (!trimmed) return { defective: false, type: null }; // blank -> fill-only's job, not this classifier's

  // Mangled Unicode (U+FFFD replacement char) — universal across all three
  // fields, checked first: a mid-character byte-level cut is unambiguous
  // evidence of corruption regardless of what else the text contains.
  if (trimmed.includes("�")) return { defective: true, type: "mangled_encoding" };

  // Template leakage: byte-for-byte (after trim/case/whitespace
  // normalization) identical to a DIFFERENT provider's stored value for the
  // same field.
  if (options?.othersForField?.length) {
    const normalized = normalizeForDuplicateCompare(trimmed);
    for (const other of options.othersForField) {
      const otherTrimmed = (other ?? "").trim();
      if (!otherTrimmed) continue;
      if (normalizeForDuplicateCompare(otherTrimmed) === normalized) {
        return { defective: true, type: "duplicate_of_other_provider" };
      }
    }
  }

  if (GARDSSALG_UI_CHROME_RE.test(trimmed)) return { defective: true, type: "ui_chrome_leakage" };
  if (looksLikeCssOrJsLeakage(trimmed)) return { defective: true, type: "css_js_leakage" };

  // Marker lists above are plain ASCII (cookie/placeholder wording never
  // needs æ/ø/å), so a bare lowercase is enough — no accent-stripping needed
  // (search-enrich.ts's stripNorwegianAccents is module-private there,
  // unlike GENERIC_ABOUT_MARKERS's own accent-stripped comparison, which
  // exists for OTHER markers not needed here).
  const lower = trimmed.toLowerCase();
  if (GARDSSALG_PLACEHOLDER_MARKERS.some((m) => lower.includes(m))) {
    return { defective: true, type: "placeholder" };
  }
  if (GARDSSALG_COOKIE_NOTICE_MARKERS.some((m) => lower.includes(m))) {
    return { defective: true, type: "boilerplate" };
  }

  const floor = GARDSSALG_QUALITY_MIN_CHARS[fieldName];
  if (trimmed.length < floor) return { defective: true, type: "too_short" };

  if (looksTruncatedMidSentence(trimmed)) return { defective: true, type: "truncated_mid_sentence" };

  // Cheap-bar backstop, prose fields only (about_text/visit_text):
  // opening_hours_text is legitimately non-prose (day/time notation with no
  // Norwegian sentence markers, e.g. "Man-fre 10-18"), so the Norwegian-
  // language check would false-positive on it constantly — deliberately
  // exempt. `floor` is passed as minLen so this call structurally can never
  // re-trip "too_short" (trimmed.length >= floor already, checked above);
  // only its boilerplate/foreign verdicts are reachable here, giving a
  // second, independently-reviewed opinion beyond this classifier's own
  // marker lists above — reuses the SAME logic the rest of the gårdssalg
  // pipeline already trusts (search-enrich.ts), rather than re-deriving a
  // parallel language/boilerplate heuristic.
  if (fieldName !== "opening_hours_text") {
    const cheapBarVerdict = classifyAboutCheapBar(trimmed, floor);
    if (cheapBarVerdict === "foreign") return { defective: true, type: "wrong_language" };
    if (cheapBarVerdict === "boilerplate") return { defective: true, type: "boilerplate" };
  }

  return { defective: false, type: null };
}

// ── B′. Address defect classifier (dev-request 2026-08-29-gardssalg-set-
// address) ───────────────────────────────────────────────────────────────
//
// A companion to classifyGardssalgFieldDefect above for `adresse` — which is
// deliberately NOT a member of GardssalgQualityFieldName/GARDSSALG_QUALITY_
// FIELDS (it never participates in the quality-REPLACEMENT margin logic (C)
// or the anti-churn gate (D); POST /admin/gardssalg-set-address is a plain
// manual-correction lever, not a "richer candidate" judgment, so widening
// the closed union just to reach this check would also widen POST
// /admin/gardssalg-set-content-field's own `field` vocabulary — out of
// scope). Reuses this module's placeholder-marker vocabulary
// (GARDSSALG_PLACEHOLDER_MARKERS) and the mangled-encoding check rather than
// re-deriving either; drops every category that makes no sense for a short
// address string — UI-chrome/CSS-leakage, mid-sentence truncation,
// wrong-language, cookie-notice, duplicate-of-other-provider — a street
// address is never scraped prose, so none of those failure modes apply.
const GARDSSALG_ADDRESS_MIN_CHARS = 4;

export function classifyGardssalgAddressDefect(rawValue: string | null | undefined): GardssalgDefectVerdict {
  const trimmed = (rawValue ?? "").trim();
  if (!trimmed) return { defective: false, type: null }; // blank -> the caller's own value_required gate, not this classifier's job
  if (trimmed.includes("�")) return { defective: true, type: "mangled_encoding" };
  const lower = trimmed.toLowerCase();
  if (GARDSSALG_PLACEHOLDER_MARKERS.some((m) => lower.includes(m))) {
    return { defective: true, type: "placeholder" };
  }
  if (trimmed.length < GARDSSALG_ADDRESS_MIN_CHARS) return { defective: true, type: "too_short" };
  return { defective: false, type: null };
}

// ── C. Margin proxy (info-point coverage) ───────────────────────────────
//
// "Candidate covers MORE of the field's information points than the
// current value" — a simple keyword/section-presence count, per field type,
// as an acceptable measurable proxy (dev-request's own words). Each
// category is a small, documented keyword/regex set; the score is the COUNT
// of distinct categories present (0..N), not a weighted/graded score — this
// keeps the margin rule simple and auditable ("candidate hits 3 categories,
// current hits 1" is legible in a report; a weighted score would not be).

const GARDSSALG_ABOUT_INFO_CATEGORIES: readonly RegExp[] = [
  // products: what the farm/producer makes or sells
  /\b(produkt|produserer|dyrker|brygger|lager|selger|vin|øl|sider|mjød|brennevin|gin|whisky|akevitt|ost|honning|bær|frukt|grønnsak|egg|kjøtt|saft)\w*/i,
  // location: where the farm/producer is
  /\b(gård(?:en|s)?|gårdsbruk|beliggende|ligger|adresse|kommune|fylke)\b|\b\d{4}\b/i,
  // what's offered: activities/services beyond the raw product itself
  /\b(tilbyr|smaking|omvisning|butikk(?:en)?|utsalg|gårdsbutikk|opplevelse)\w*/i,
  // visit info: how/when to actually visit
  /\b(åpningstider|åpent|besøk(?:e)?|velkommen|book|bestill|kontakt|parkering)\w*/i,
];

const GARDSSALG_VISIT_INFO_CATEGORIES: readonly RegExp[] = [
  // when: opening hours / seasonal timing
  /\b(åpningstider|åpent|sesong|sommer|vinter|hele\s+året)\w*/i,
  // where/how to get there
  /\b(adresse|beliggende|ligger|vei(?:en)?|parkering|kommune)\w*/i,
  // how to book/arrange the visit
  /\b(book|bestill|kontakt|påmelding|reservasjon|ring|epost|e-post)\w*/i,
  // what to expect while there
  /\b(smaking|omvisning|rundvisning|butikk(?:en)?|utsalg|guide(?:t)?)\w*/i,
];

// opening_hours_text is inherently short/structured — "richer" mainly means
// covering more of the STRUCTURE a real hours notation has, not more prose
// categories: distinct weekday coverage, an actual time range, and any
// seasonal/exception qualifier.
const GARDSSALG_HOURS_INFO_CATEGORIES: readonly RegExp[] = [
  /\b(man(?:dag)?|tirs(?:dag)?|ons(?:dag)?|tors(?:dag)?|fre(?:dag)?|lør(?:dag)?|søn(?:dag)?|mon|tue|wed|thu|fri|sat|sun)\b/i,
  /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*[-–]\s*\d{1,2}\b/,
  /\b(sommer|vinter|sesong|jul|påske|helligdag(?:er)?|stengt)\w*/i,
];

function categoriesFor(fieldName: GardssalgQualityFieldName): readonly RegExp[] {
  if (fieldName === "about_text") return GARDSSALG_ABOUT_INFO_CATEGORIES;
  if (fieldName === "visit_text") return GARDSSALG_VISIT_INFO_CATEGORIES;
  return GARDSSALG_HOURS_INFO_CATEGORIES;
}

/**
 * Count how many distinct information-point categories `rawValue` covers for
 * `fieldName` — the measurable proxy for "richness" the margin rule (C)
 * compares. PURE. Returns 0 for blank/null input.
 */
export function countGardssalgInfoPoints(
  fieldName: GardssalgQualityFieldName,
  rawValue: string | null | undefined
): number {
  const text = (rawValue ?? "").trim();
  if (!text) return 0;
  let count = 0;
  for (const re of categoriesFor(fieldName)) {
    if (re.test(text)) count++;
  }
  return count;
}

// ── B + C combined: the field-level replace decision ────────────────────

export interface GardssalgFieldReplacementDecision {
  shouldReplace: boolean;
  /** "defect:<type>" | "margin" | null (null iff shouldReplace is false). */
  reason: string | null;
}

/**
 * The pure policy decision (Skive 3-B + 3-C), independent of owner-lock (A,
 * checked separately — see the module doc comment) and anti-churn (D,
 * requires DB access — see checkGardssalgAntiChurn below). PURE — no DB, no
 * network. Shared by the route's dry-run planning pass AND
 * applyGardssalgQualityReplacement's fresh re-verification at write time, so
 * the two can never drift apart (same discipline as
 * gardssalgReplaceableFieldAction in experience-store.ts).
 *
 * Order:
 *   1. current blank -> never (fill-only's job, out of scope for this
 *      lever).
 *   2. current's defect status (B) is classified ONCE here, up front, and
 *      reused by every branch below — this must happen even when the
 *      candidate turns out to be blank or itself defective, so report-mode
 *      can always surface a real current-side defect instead of masking it.
 *   3. candidate blank, OR the candidate ITSELF is defective (never replace
 *      bad with bad — defense in depth beyond whatever gate produced the
 *      candidate) -> never; reason is "current_defective_no_clean_candidate"
 *      if current IS defective (there's a real defect, just no clean
 *      candidate to fix it with), else null.
 *   4. current is defective (B) -> replace, reason "defect:<type>".
 *   5. candidate is byte-identical to current -> never (nothing to gain).
 *   6. candidate strictly covers MORE info-point categories than current
 *      (C) -> replace, reason "margin". A candidate that covers the SAME or
 *      FEWER categories never replaces — "a shorter/less-specific candidate
 *      must never replace a richer current value" is enforced by this
 *      being a strict `>`, not `>=`.
 *   7. otherwise -> never.
 */
export function planGardssalgFieldReplacement(
  fieldName: GardssalgQualityFieldName,
  currentValue: string | null | undefined,
  candidateValue: string | null | undefined,
  othersForField?: readonly (string | null | undefined)[]
): GardssalgFieldReplacementDecision {
  const current = (currentValue ?? "").trim();
  const candidate = (candidateValue ?? "").trim();
  if (!current) return { shouldReplace: false, reason: null };

  const currentDefect = classifyGardssalgFieldDefect(fieldName, current, { othersForField });

  if (!candidate) {
    return {
      shouldReplace: false,
      reason: currentDefect.defective ? "current_defective_no_clean_candidate" : null,
    };
  }

  const candidateDefect = classifyGardssalgFieldDefect(fieldName, candidate);
  if (candidateDefect.defective) {
    return {
      shouldReplace: false,
      reason: currentDefect.defective ? "current_defective_no_clean_candidate" : null,
    };
  }

  if (currentDefect.defective) {
    return { shouldReplace: true, reason: `defect:${currentDefect.type}` };
  }

  if (candidate === current) return { shouldReplace: false, reason: null };

  const currentPoints = countGardssalgInfoPoints(fieldName, current);
  const candidatePoints = countGardssalgInfoPoints(fieldName, candidate);
  if (candidatePoints > currentPoints) {
    return { shouldReplace: true, reason: "margin" };
  }
  return { shouldReplace: false, reason: null };
}

// ── D. Anti-churn ────────────────────────────────────────────────────────

/** SHA-256 of the fetched source text, hex-encoded. Simple, no existing hashing convention for source page content elsewhere in this pipeline to reuse (checked — see build report). */
export function hashGardssalgSourceContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Stamped into gardssalg_content_audit.notes (JSON) on every row THIS lever
// inserts — lets checkGardssalgAntiChurn (and a future reader) tell a
// quality-update replacement apart from every other gårdssalg writer's audit
// rows on the same table, without a new column/marker convention (mirrors
// GARDSSALG_PROVIDER_MERGE_MARKER's role in gardssalg-provider-merge.ts,
// except that marker lives in source_url — this one lives in notes because
// source_url here must stay the REAL fetched evidence URL, not a sentinel).
export const GARDSSALG_QUALITY_UPDATE_LEVER = "gardssalg-content-quality-update";
export const GARDSSALG_QUALITY_ANTI_CHURN_DAYS = 30;

export interface GardssalgAntiChurnResult {
  allowed: boolean;
  reason?: "recent_replacement_same_source";
  last_changed_at?: string;
}

/**
 * D: the same (provider_id, field_name) pair may be replaced by THIS lever
 * at most once per GARDSSALG_QUALITY_ANTI_CHURN_DAYS days, UNLESS the source
 * page's content hash has changed since the last replacement. Looks up the
 * MOST RECENT gardssalg_content_audit row THIS lever wrote for the pair
 * (identified via the notes-JSON lever marker above) within the window,
 * using pure-SQL `datetime('now','-N days')` comparison — the SAME
 * TZ-correct discipline every other 30-day-style check in this codebase
 * uses (see e.g. providerParkingExclusionSql, experience-store.ts, and
 * lokal-agent-verifier-tz-parking.test.ts's own doc comment for the JS-
 * Date-arithmetic bug class this convention exists to avoid). No row within
 * the window -> allowed (never replaced by this lever recently, or the last
 * replacement has already aged out). A row within the window -> allowed
 * only if its stored content_hash differs from `freshContentHash` (the
 * source page genuinely changed since).
 */
export function checkGardssalgAntiChurn(
  db: Database.Database,
  providerId: string,
  fieldName: GardssalgQualityFieldName,
  freshContentHash: string
): GardssalgAntiChurnResult {
  const row = db
    .prepare(
      `SELECT changed_at, notes
         FROM gardssalg_content_audit
        WHERE provider_id = ?
          AND field_name = ?
          AND notes LIKE ?
          AND changed_at > datetime('now', '-${GARDSSALG_QUALITY_ANTI_CHURN_DAYS} days')
        ORDER BY changed_at DESC, rowid DESC
        LIMIT 1`
    )
    .get(providerId, fieldName, `%"lever":"${GARDSSALG_QUALITY_UPDATE_LEVER}"%`) as
    | { changed_at: string; notes: string | null }
    | undefined;
  if (!row) return { allowed: true };

  let lastHash: string | null = null;
  if (row.notes) {
    try {
      const parsed = JSON.parse(row.notes);
      if (parsed && typeof parsed === "object" && typeof parsed.content_hash === "string") {
        lastHash = parsed.content_hash;
      }
    } catch {
      /* malformed notes JSON -> treat as no known hash, fail toward blocking below */
    }
  }
  if (lastHash && lastHash !== freshContentHash) return { allowed: true };
  return { allowed: false, reason: "recent_replacement_same_source", last_changed_at: row.changed_at };
}

// ── E. The writer ────────────────────────────────────────────────────────

export interface GardssalgQualityPlanItem {
  provider_id: string;
  field_name: GardssalgQualityFieldName;
  current_value: string;
  candidate_value: string;
  reason: string; // "defect:<type>" | "margin"
  source_url: string;
  content_hash: string;
}

export type GardssalgQualityApplyOutcome =
  | "applied"
  | "owner_locked"
  | "anti_churn_blocked"
  | "no_longer_replaceable"
  | "not_found"
  | "error";

export interface GardssalgQualityApplyResult {
  provider_id: string;
  field_name: GardssalgQualityFieldName;
  outcome: GardssalgQualityApplyOutcome;
  reason?: string;
}

/**
 * Apply ONE planned replacement inside its own transaction. Re-verifies
 * EVERYTHING against a FRESH row read taken inside the transaction — never
 * trusts the caller's (possibly-stale, planned-earlier-in-the-run) snapshot
 * — same defense-in-depth discipline applyGardssalgProviderMergePair uses
 * (gardssalg-provider-merge.ts):
 *   1. owner-lock (A) — isGardssalgFieldOwnerLocked against the fresh row.
 *   2. anti-churn (D) — checkGardssalgAntiChurn against the fresh DB state.
 *   3. the replace decision itself (B/C, via planGardssalgFieldReplacement)
 *      — re-run against the FRESH current value, not the planned one, so a
 *      field the owner (or another lever) changed between planning and this
 *      call is caught here rather than silently overwritten.
 * `othersForField` is optional and re-passed here so the duplicate-of-
 * another-provider defect check (part of step 3's re-verification) stays
 * consistent with whatever the caller used to plan — omit it to skip that
 * one sub-check on re-verification (every other defect/margin check still
 * runs).
 *
 * On success: writes `field_name`, stamps content_source='provider_site'
 * (unless the row is 'claim' — same "never re-stamp a still-claimed row's
 * identity" rule applyGardssalgProviderContent enforces, so a per-field
 * write never silently unlocks the row's OTHER owner-locked fields),
 * content_evidence_url, content_updated_at, merges field_provenance
 * (read-modify-write, preserves every other field's entry — never clobbers)
 * with a `content_hash` alongside the existing `source_url`/`fetched_at`
 * shape, and inserts exactly ONE gardssalg_content_audit row (old_value =
 * the fresh pre-write value, new_value = the candidate, source_url = the
 * real fetched evidence URL, batch_id, changed_by 'system', notes = JSON
 * `{lever, reason, content_hash}` — the SAME notes-as-structured-JSON
 * convention applyGardssalgRollbackVetoOverride already uses for its own
 * free-text `notes` column, here machine-readable so checkGardssalgAntiChurn
 * above can read it back).
 */
export function applyGardssalgQualityReplacement(
  db: Database.Database,
  item: GardssalgQualityPlanItem,
  batchId: string,
  othersForField?: readonly (string | null | undefined)[]
): GardssalgQualityApplyResult {
  const base = { provider_id: item.provider_id, field_name: item.field_name };
  if (!isGardssalgQualityFieldName(item.field_name)) {
    return { ...base, outcome: "error", reason: "invalid_field" };
  }
  try {
    const tx = db.transaction((): GardssalgQualityApplyResult => {
      const row = db
        .prepare(
          `SELECT id, content_source, about_text, visit_text, opening_hours_text, field_provenance
             FROM experience_providers WHERE id = ?`
        )
        .get(item.provider_id) as
        | {
            id: string;
            content_source: string | null;
            about_text: string | null;
            visit_text: string | null;
            opening_hours_text: string | null;
            field_provenance: string | null;
          }
        | undefined;
      if (!row) return { ...base, outcome: "not_found" };

      // isGardssalgFieldOwnerLocked itself already encodes: 'manual' -> always
      // locked; 'claim' -> per-field field_provenance.owner_locks lookup;
      // anything else -> never locked. One call covers every content_source.
      if (isGardssalgFieldOwnerLocked(row, item.field_name)) {
        return { ...base, outcome: "owner_locked" };
      }

      const antiChurn = checkGardssalgAntiChurn(db, item.provider_id, item.field_name, item.content_hash);
      if (!antiChurn.allowed) {
        return { ...base, outcome: "anti_churn_blocked", reason: antiChurn.reason };
      }

      const freshCurrent = row[item.field_name];
      const decision = planGardssalgFieldReplacement(item.field_name, freshCurrent, item.candidate_value, othersForField);
      if (!decision.shouldReplace) {
        return { ...base, outcome: "no_longer_replaceable" };
      }

      let provenance: Record<string, { source_url: string; fetched_at: string; content_hash?: string }> = {};
      if (row.field_provenance) {
        try {
          const parsed = JSON.parse(row.field_provenance);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            provenance = parsed;
          }
        } catch {
          /* malformed existing JSON -> treat as empty rather than clobber the write */
        }
      }
      provenance[item.field_name] = {
        source_url: item.source_url,
        fetched_at: new Date().toISOString(),
        content_hash: item.content_hash,
      };

      const sets = [`${item.field_name} = @newVal`, `content_evidence_url = @evidenceUrl`, `content_updated_at = datetime('now')`, `field_provenance = @fieldProvenance`];
      // Same "never re-stamp a still-claimed row's content_source" guard
      // applyGardssalgProviderContent enforces (experience-store.ts) — a
      // per-field write on a 'claim' row must not silently unlock its OTHER
      // owner-locked fields by flipping content_source away from 'claim'.
      if (row.content_source !== "claim") {
        sets.push(`content_source = 'provider_site'`);
      }
      db.prepare(`UPDATE experience_providers SET ${sets.join(", ")} WHERE id = @id`).run({
        id: item.provider_id,
        newVal: item.candidate_value,
        evidenceUrl: item.source_url,
        fieldProvenance: JSON.stringify(provenance),
      });

      db.prepare(
        `INSERT INTO gardssalg_content_audit
           (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at, notes)
         VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'), @notes)`
      ).run({
        id: uuid(),
        provider_id: item.provider_id,
        field_name: item.field_name,
        old_value: freshCurrent,
        new_value: item.candidate_value,
        source_url: item.source_url,
        batch_id: batchId,
        notes: JSON.stringify({ lever: GARDSSALG_QUALITY_UPDATE_LEVER, reason: decision.reason, content_hash: item.content_hash }),
      });

      return { ...base, outcome: "applied" };
    });
    return tx();
  } catch (e: any) {
    return { ...base, outcome: "error", reason: `write_failed: ${e?.message ?? String(e)}` };
  }
}
