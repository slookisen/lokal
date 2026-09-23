// ─── Admin: POST /admin/phone-context-gate-retro-scan ───────────────────────
//
// dev-request 2026-09-22-telefon-css-js-identifikator-falske-positiver,
// point 3. Points 1-2 of the same dev-request harden the DETERMINISTIC
// extractor (services/search-enrich.ts's extractPhones — see its own
// phoneCandidateHasAlnumNeighbour() comment) so it no longer accepts an
// 8-digit run whose only occurrence is embedded in a longer alphanumeric
// token — the exact shape that put Bjørke Gård's "35267336" (a slice of a
// Facebook App ID JSON blob) and Drivhuset Bageri's "45352419" (a slice of
// a Wix CSS class name) into agent_knowledge.phone. That fix only protects
// FUTURE extractions; this route is the ONE-TIME retro-scan of rows already
// written before the fix — "which existing phone values would the FIXED
// rule now reject".
//
// ── Why this is a RE-FETCH, not a pure DB read (unlike its sibling
//    admin-contact-write-guard-retro-sweep.ts) ──────────────────────────────
// The stored `agent_knowledge.phone` value is already just 8 bare digits —
// the surrounding page text the context-gate rule needs to judge (script/
// style block? welded onto a longer alphanumeric token?) was never
// persisted anywhere. There is no way to re-apply "rule (1)" to a bare
// digit string in the DB alone. So this scan re-fetches each row's
// homepage (COALESCE(agent_knowledge.website, agents.url) — the SAME
// `homepage_url` concept every other call site in this codebase already
// computes) and re-judges the stored value against the FRESH html.
// `fetchImpl` is injectable purely for tests (mirrors fetch-page.ts's own
// FetchPageOptions.fetchImpl seam) — production never passes it.
//
// ── The oracle: "found+rejected" is the ONLY route to would_reject ─────────
// CHANGES-REQUESTED fix (adversarial review of the first cut of this route):
// the original oracle was "is the stored value in extractPhones(rootPageHtml)?
// if not -> would_reject". That is strictly NARROWER than how phones are
// genuinely written in the first place — buildPageEvidence
// (services/search-enrich.ts) unions extractPhones() over the root page PLUS
// up to 3 link-discovered subpages, and a real number can also be written as
// a `tel:` link, a JSON-LD `telephone` field, or a `<meta>` contact tag —
// none of which extractPhones() can ever see (it works on VISIBLE text only;
// script/style content and tag attributes are stripped before it scans), and
// Norwegian mobile grouping (`+47 91 23 45 67`, `912 34 567`) can also miss
// extractPhones()'s own strict 2-2-2-2 grouping regex. A retro-scan whose
// oracle is "not extractable by extractPhones() on ONE page" would blank
// real, verified phone numbers for real customers — a data-loss bug, not a
// cosmetic one.
//
// scanOnePhoneRow() therefore judges each row with a wider net than
// extractPhones() alone, over the root page PLUS up to
// PHONE_RETRO_SCAN_MAX_SUBPAGES same-domain subpages (the SAME link-driven
// discovery point 2 of this dev-request built — fieldSpotCheckSubpageCandidates,
// src/agents/lokal-agent-verifier.ts — reused here as-is, not re-derived):
//   - `tel:` links, JSON-LD `telephone` fields (any depth) and `<meta
//     name/property/itemprop="...phone...">` tags all count as a POSITIVE,
//     unconditional match — they are structured data, never subject to the
//     "welded to a CSS/JS identifier" concern that motivates the context
//     gate in the first place.
//   - Free page text is scanned with a LOOSER digit-run search than
//     extractPhones() (any grouping/spacing of the same 8 digits, with or
//     without a `+47`/`0047`/`47` prefix) so a genuine but unusually-grouped
//     number is still found. Each occurrence is then judged exactly like
//     phoneCandidateHasAlnumNeighbour() judges an extractPhones() candidate:
//     bounded by non-alphanumeric characters (or the string edge) -> clean;
//     glued directly onto a longer alphanumeric run -> welded. An occurrence
//     found ONLY inside a <script>/<style> block is ALSO reject-shape,
//     regardless of its local neighbours, for the same reason
//     extractPhones() strips that content before scanning at all.
// Only when the digits are found SOMEWHERE reachable, and EVERY occurrence
// found is either script/style-embedded or welded, does a row become
// `would_reject`. If the digits cannot be re-found anywhere reachable at
// all, that is NOT evidence the new rule rejects them — a page can easily
// have changed, dropped its contact section, or simply not exposed a phone
// in machine-checkable text — so an unfound value is `unverifiable`, never
// `would_reject`. `ok` wins over everything: a row is only ever flagged when
// NO clean/structured occurrence was found anywhere fetched.
//
// ── Fail-closed toward NOT flagging ──────────────────────────────────────
// A homepage that cannot be fetched at all (dead link, timeout, no
// homepage_url on file) is reported as `unverifiable`, NEVER as a rejection
// — an outage or a missing URL is never evidence the stored phone is bad
// (same posture as computeFieldSpotCheck, src/agents/lokal-agent-verifier.ts,
// point 2 of this same dev-request).
//
// ── dry-run by default, apply is a real write path ──────────────────────────
// `dry_run` (body) defaults to `true`. The ONLY way into apply-mode is the
// literal boolean `false` — `dry_run: false` — mirroring
// admin-bm-producer-harvest.ts's own "the ONLY way in is the literal string/
// value, anything else stays on the safe dry-run path" convention, per this
// dev-request's own explicit spec ("apply requires an explicit dry_run:false
// flag (same pattern as other triage-apply admin routes in this repo)").
// A dry-run performs ZERO network fetches beyond the read-only re-check
// fetches described above and ZERO writes.
//
// ── What apply writes, per flagged row ───────────────────────────────────
// `agent_knowledge.phone` is BLANKED to NULL (fail-closed — a rejected
// value is never partially kept or guessed-at, same "En avvist verdi skal
// la feltet stå BLANKT" posture as admin-contact-write-guard-retro-sweep.ts)
// AND `agent_knowledge.verification_status` is reset to `'pending_verify'`
// so the verifier's gate re-judges the row from scratch on its next pass,
// per this dev-request's own spec ("resets verification_status so the gate
// re-judges them").
//
// ── Lock-respect (same discipline as every other retro-sweep in this repo,
//    e.g. admin-contact-write-guard-retro-sweep.ts) ─────────────────────────
//   - `agents.claimed_at IS NOT NULL` -> ROW-level lock, never touched.
//   - `agent_knowledge.curated_fields` -> PER-FIELD lock, checked for
//     "phone" specifically.
//   - Both re-read from a FRESH row snapshot immediately before the write,
//     inside that write's own db.transaction().
//
// Scope: every agent_knowledge row with a non-blank `phone`, all verticals
// (same "no cohort filter" scope as admin-contact-write-guard-retro-sweep.ts,
// the sibling this route's report shape mirrors).
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase).
//
// NOTE (build-time deliverable, per this dev-request's own explicit
// instruction): this route is code + tests only. Nobody has run apply mode
// against a live database as part of building this — see
// phone-context-gate-retro-scan.test.ts for the dry-run-only coverage.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { fetchPage } from "../services/fetch-page";
import { normalizePhone } from "../services/search-enrich";
import { fieldSpotCheckSubpageCandidates } from "../agents/lokal-agent-verifier";

const router = Router();

// ── Batch/limit convention (mirrors admin-rfb-website-discovery.ts's
//    RFB_WD_DEFAULT_LIMIT/RFB_WD_HARD_CAP/RFB_WD_TIME_BUDGET_MS — see that
//    file's own comment for why an admin route doing one-or-more live
//    fetches per row needs BOTH a per-call row cap and an overall wall-clock
//    budget: unbounded sequential fetching previously caused proxy timeouts
//    / 0-byte responses). This route's per-row cost is comparable to RFB
//    website-discovery's (1 root fetch, occasionally +1..3 subpage fetches
//    on top) so it takes the SAME numbers rather than inventing new ones. ──
export const PHONE_RETRO_SCAN_DEFAULT_LIMIT = 25;
export const PHONE_RETRO_SCAN_HARD_CAP = 48;
export const PHONE_RETRO_SCAN_TIME_BUDGET_MS = 30_000;
// Up to 3 same-domain subpages per row, same cap point 2 of this dev-request
// already established (fieldSpotCheckSubpageCandidates's own default).
const PHONE_RETRO_SCAN_MAX_SUBPAGES = 3;

// Test-only injection point for the wall-clock used by the time-budget check
// (mirrors admin-rfb-website-discovery.ts's __setRfbWdNowForTesting):
// production always leaves this null and gets the real Date.now().
let phoneRetroScanNowForTesting: (() => number) | null = null;
export function __setPhoneRetroScanNowForTesting(fn: (() => number) | null): void {
  phoneRetroScanNowForTesting = fn;
}
function effectivePhoneRetroScanNowMs(): number {
  return phoneRetroScanNowForTesting ? phoneRetroScanNowForTesting() : Date.now();
}

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

interface KnowledgeRow {
  agent_id: string;
  phone: string;
  website: string | null;
  url: string | null;
  claimed_at: string | null;
  curated_fields: string | null;
}

/** True iff the parsed curated_fields JSON locks "phone". Tolerates
 *  malformed/missing JSON (treated as "not locked") — same defensive-parse
 *  convention as isContactFieldCurated (admin-contact-write-guard-retro-
 *  sweep.ts) / isContactPhoneCurated (admin-bm-producer-harvest.ts). */
function isPhoneFieldCurated(curatedFieldsJson: string | null | undefined): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    return !!(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).phone);
  } catch {
    return false;
  }
}

export type PhoneRetroScanRowVerdict = "ok" | "would_reject" | "unverifiable";

export interface PhoneRetroScanRowResult {
  agent_id: string;
  verdict: PhoneRetroScanRowVerdict;
  reason: string;
  homepage_url: string | null;
}

// ═══════════════════════════════════════════════════════════════════════
// ── Per-page phone judgement (B1 fix) ─────────────────────────────────────
// See the module header comment ("The oracle: found+rejected is the ONLY
// route to would_reject") for the full rationale. Everything below is a
// PURE, no-network helper operating on one already-fetched page's HTML.
// ═══════════════════════════════════════════════════════════════════════

const ALNUM_RE = /[A-Za-z0-9]/;

/** Strip <script>/<style> block CONTENT, then all remaining tags, to plain
 *  visible text — the SAME shape extractPhones() itself scans (search-
 *  enrich.ts). Kept as an independent copy here (never imports the private
 *  helper) so this route's oracle stays self-contained and auditable. */
function visiblePhoneText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return stripped.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
}

/** The concatenated inner text of every <script>/<style> block on the page
 *  (raw — tags are not stripped further, script/style content is never
 *  itself HTML markup). A digit run found ONLY here is a script/style
 *  artifact by construction — extractPhones() would never see it either. */
function scriptStylePhoneText(html: string): string {
  const blocks: string[] = [];
  const re = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[2] ?? "");
  return blocks.join("\n");
}

/** A regex that finds `digits` (an 8-digit string) anywhere in `text`,
 *  tolerating an OPTIONAL single whitespace/dot/dash between every pair of
 *  adjacent digits (so ANY real-world grouping — "912 34 567", "91 23 45 67",
 *  "91-234-567", "91234567" — matches the SAME 8 digits) and an optional
 *  leading country-code prefix ("+47"/"0047"/"47", with or without its own
 *  separator before the digits). Separators are optional, not required, so
 *  a run of the same 8 digits welded with ZERO separators inside a longer
 *  alphanumeric token (the Bjørke Gård / Drivhuset Bageri shapes) still
 *  matches — the neighbour-context check below is what tells the two apart,
 *  not this regex. */
function buildLoosePhoneRegex(digits: string): RegExp {
  const digitPattern = digits.split("").join("[\\s.\\-]?");
  return new RegExp(`(?:(?:\\+?47|0047)[\\s.\\-]?)?(${digitPattern})`, "g");
}

type LooseTextVerdict = "clean" | "welded" | "absent";

/** Scan `text` for every loose occurrence of `digits`; "clean" if ANY
 *  occurrence is bounded by a non-alphanumeric character (or a string edge)
 *  on both sides, "welded" if occurrences exist but EVERY one is glued to a
 *  longer alphanumeric run, "absent" if `digits` doesn't appear at all. */
function classifyLoosePhoneOccurrences(text: string, digits: string): LooseTextVerdict {
  const re = buildLoosePhoneRegex(digits);
  let sawAny = false;
  let sawWelded = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    sawAny = true;
    const groupStart = m.index + (m[0].length - m[1]!.length);
    const groupEnd = groupStart + m[1]!.length;
    const before = m.index > 0 ? text[m.index - 1] : "";
    const after = groupEnd < text.length ? text[groupEnd] : "";
    const welded = ALNUM_RE.test(before) || ALNUM_RE.test(after);
    if (!welded) return "clean";
    sawWelded = true;
  }
  if (!sawAny) return "absent";
  return sawWelded ? "welded" : "clean";
}

/** Percent-decode `text` (best-effort): replaces every `%XX` escape with the
 *  corresponding character via `String.fromCharCode`. Deliberately NOT
 *  `decodeURIComponent`, which THROWS on a malformed or partial multi-byte
 *  UTF-8 escape sequence — routine in an arbitrary slice of a script/style
 *  block that was never meant to be parsed as a URI component. This route
 *  only needs ASCII punctuation/digits to survive intact for the loose-text
 *  neighbour check below, so a mis-decoded multi-byte (e.g. Norwegian
 *  letter) escape is harmless; never throws. */
function percentDecodeForPhoneMatch(text: string): string {
  return text.replace(/%[0-9A-Fa-f]{2}/g, (seq) => String.fromCharCode(parseInt(seq.slice(1), 16)));
}

/** Decode the HTML entities relevant to the loose-text neighbour check
 *  (quotes/angle-brackets/ampersand, plus numeric decimal/hex entities) —
 *  not a general-purpose HTML entity decoder. `&amp;` is decoded LAST so a
 *  double-escaped entity (e.g. `&amp;quot;`) decodes to the literal text
 *  `&quot;` rather than being incorrectly unescaped twice into `"`. */
function htmlEntityDecodeForPhoneMatch(text: string): string {
  return text
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9A-Fa-f]+);/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/gi, "&");
}

/** Applies percent-decoding then HTML-entity-decoding (in that order) to
 *  `text` — a page can legitimately contain a URL-encoded (or HTML-entity-
 *  encoded) JSON blob inside a <script> block (e.g. `%22phone%22%3A%22%2B...`,
 *  the URL-encoding of `"phone":"+...`) where the raw, undecoded digit run
 *  is welded to an encoding artifact character (a literal "B" from "%2B")
 *  even though the number is genuinely cleanly quoted once decoded. Never
 *  throws (see percentDecodeForPhoneMatch). Callers decode the ALREADY-
 *  EXTRACTED text (visiblePhoneText()/scriptStylePhoneText() output), never
 *  the raw pre-extraction html, so a decode that happens to produce "<"/">"
 *  can't corrupt tag-boundary detection. */
function decodeForPhoneMatch(text: string): string {
  return htmlEntityDecodeForPhoneMatch(percentDecodeForPhoneMatch(text));
}

/** Combine two loose-text verdicts — a raw-text scan and a decoded-text scan
 *  of the SAME extracted text — into one: "clean" wins if either input is
 *  "clean", else "welded" wins if either is "welded", else "absent". */
function bestLooseVerdict(a: LooseTextVerdict, b: LooseTextVerdict): LooseTextVerdict {
  if (a === "clean" || b === "clean") return "clean";
  if (a === "welded" || b === "welded") return "welded";
  return "absent";
}

/** True iff `digits` is reachable via a `tel:` link on the page (any
 *  formatting — normalizePhone() handles +47/0047/separators). */
function phoneFoundViaTelLink(html: string, digits: string): boolean {
  const re = /href\s*=\s*["']tel:([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (normalizePhone(m[1]) === digits) return true;
  }
  return false;
}

/** True iff `val` is a phone-shaped JSON-LD value (string OR number — some
 *  hand-authored JSON-LD emits `"telephone": 91234567` unquoted) that
 *  normalises to `digits`. */
function jsonLdScalarMatchesPhone(val: unknown, digits: string): boolean {
  if (typeof val === "string") return normalizePhone(val) === digits;
  if (typeof val === "number" && Number.isFinite(val)) return normalizePhone(String(val)) === digits;
  return false;
}

/** Recursively search a parsed JSON-LD node/tree for a "telephone"-ish key
 *  (schema.org LocalBusiness/Organization commonly nest under `address`,
 *  `contactPoint`, etc.) whose value normalises to `digits`. A phone-shaped
 *  key's value may itself be a bare string/number OR an array of them
 *  (`"telephone":["91234567","22334455"]`) — every element is checked.
 *  Depth-capped as an anti-pathology guard, not a correctness limit — real
 *  JSON-LD blocks are shallow. */
function jsonLdNodeHasPhone(node: unknown, digits: string, depth = 0): boolean {
  if (depth > 8 || node == null || typeof node !== "object") return false;
  if (Array.isArray(node)) {
    return node.some((n) => jsonLdNodeHasPhone(n, digits, depth + 1));
  }
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (/phone|telephone/i.test(key)) {
      if (jsonLdScalarMatchesPhone(val, digits)) return true;
      if (Array.isArray(val) && val.some((item) => jsonLdScalarMatchesPhone(item, digits))) return true;
    }
    if (val && typeof val === "object" && jsonLdNodeHasPhone(val, digits, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** Fallback for a <script type="application/ld+json"> block whose content
 *  fails JSON.parse (e.g. a trailing comma — common in hand-edited pages):
 *  a simple proximity scan for a `"telephone"`/`"phone"` key (quoted or
 *  bare) followed within a short window by the digit run, in ANY of its
 *  loose real-world groupings (same regex as the free-text scan). This is
 *  deliberately narrow — it never "guesses" a phone with no adjacent key —
 *  but lets a malformed-but-genuine JSON-LD phone still count as a
 *  structured-ish clean match instead of falling through to the (welding-
 *  gated) script/style fallback below. */
function jsonLdRawTextHasPhoneKeyAdjacency(rawText: string, digits: string): boolean {
  const KEY_RE = /["']?(?:telephone|phone)["']?\s*:/gi;
  const WINDOW = 60;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(rawText)) !== null) {
    const windowText = rawText.slice(m.index + m[0].length, m.index + m[0].length + WINDOW);
    if (buildLoosePhoneRegex(digits).test(windowText)) return true;
  }
  return false;
}

/** True iff `digits` is reachable via a `telephone`-shaped field inside any
 *  <script type="application/ld+json"> block on the page. Tolerates real-
 *  world attribute spacing/quoting (`type = "application/ld+json"`,
 *  `type=application/ld+json` unquoted). When a block's content fails
 *  JSON.parse, falls back to jsonLdRawTextHasPhoneKeyAdjacency() on that
 *  block's raw text rather than skipping it outright — see that helper's
 *  comment. */
function phoneFoundViaJsonLd(html: string, digits: string): boolean {
  const re =
    /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json(?=[\s>]))[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] ?? "").trim();
    try {
      const parsed = JSON.parse(raw);
      if (jsonLdNodeHasPhone(parsed, digits)) return true;
    } catch {
      if (jsonLdRawTextHasPhoneKeyAdjacency(raw, digits)) return true;
      continue;
    }
  }
  return false;
}

/** True iff `digits` is reachable via a phone-shaped <meta> contact tag
 *  (name/property/itemprop containing "phone" or "telephone" — e.g. Open
 *  Graph's `business:contact_data:phone_number`, or a bare `itemprop=
 *  "telephone"` microdata tag). */
function phoneFoundViaMeta(html: string, digits: string): boolean {
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const nameMatch = /(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!nameMatch || !contentMatch) continue;
    if (!/phone|telephone/i.test(nameMatch[1]!)) continue;
    if (normalizePhone(contentMatch[1]) === digits) return true;
  }
  return false;
}

export type PagePhoneJudgement = "clean" | "reject_shape" | "ambiguous_script_style" | "absent";

/**
 * Judge ONE already-fetched page's HTML for the stored `digits`:
 *   - "clean": found via a structured source, or found in visible body text
 *     cleanly bounded — a POSITIVE result, the row must not be flagged.
 *   - "reject_shape": found, but every occurrence is welded (zero separator)
 *     to a longer alphanumeric/digit run — checked with the SAME neighbour
 *     logic uniformly across visible text AND script/style content, per the
 *     B1 fix-up (round 2 review): a script/style occurrence used to be
 *     treated as reject-shape unconditionally, which wrongly blanked
 *     genuine numbers that live ONLY in a script/style block on modern
 *     sites (client-rendered state blobs, Wix warmupData, booking-widget
 *     init calls) but are themselves cleanly bounded there.
 *   - "ambiguous_script_style": the digits appear ONLY inside a
 *     <script>/<style> block, cleanly bounded (not welded) — the same shape
 *     extractPhones() itself would never see (it strips that content before
 *     scanning), so this is not confirmable as a genuine customer-facing
 *     number, but it is equally not confirmable as the bad "welded CSS
 *     class / JS identifier" shape either. The caller must NOT treat this as
 *     "clean" (would risk masking a genuinely bad value elsewhere) NOR as
 *     "reject_shape" (would risk blanking a genuine state-blob/JSON phone)
 *     — it folds into `unverifiable` alongside "absent".
 *   - "absent": not found on this page at all — NOT evidence of anything by
 *     itself; the caller must check other pages before concluding
 *     unverifiable.
 * PURE, no network.
 */
export function judgePhoneOnPage(html: string, digits: string): PagePhoneJudgement {
  if (phoneFoundViaTelLink(html, digits) || phoneFoundViaJsonLd(html, digits) || phoneFoundViaMeta(html, digits)) {
    return "clean";
  }
  const bodyText = visiblePhoneText(html);
  const bodyVerdict = bestLooseVerdict(
    classifyLoosePhoneOccurrences(bodyText, digits),
    classifyLoosePhoneOccurrences(decodeForPhoneMatch(bodyText), digits),
  );
  if (bodyVerdict === "clean") return "clean";

  // Round-4 fix (Fix C, round-3 CHANGES-REQUESTED finding): a welded
  // occurrence in visible text must NOT short-circuit straight to
  // "reject_shape" before script/style content has even been checked — a
  // page can legitimately have the SAME digits welded into a CSS/JS
  // identifier in the body (bad) while ALSO carrying a genuinely clean,
  // non-welded copy inside a <script>/<style> block (e.g. a state blob that
  // mirrors the same number) — that combination must resolve to
  // "ambiguous_script_style", exactly as it would if the body had no
  // occurrence at all. So script/style is always checked for a CLEAN match
  // before body-welding is allowed to decide reject_shape. Decision order:
  //   1. clean (non-welded) in visible text -> "clean" (handled above)
  //   2. else, clean (non-welded) in script/style -> "ambiguous_script_style"
  //   3. else, if welded somewhere (body OR script/style) -> "reject_shape"
  //   4. else (no occurrence anywhere) -> "absent"
  const scriptText = scriptStylePhoneText(html);
  const scriptVerdict = bestLooseVerdict(
    classifyLoosePhoneOccurrences(scriptText, digits),
    classifyLoosePhoneOccurrences(decodeForPhoneMatch(scriptText), digits),
  );
  if (scriptVerdict === "clean") return "ambiguous_script_style";

  if (bodyVerdict === "welded" || scriptVerdict === "welded") return "reject_shape";

  return "absent";
}

/**
 * Re-fetch ONE row's homepage (and, when the value isn't cleanly found
 * there, up to PHONE_RETRO_SCAN_MAX_SUBPAGES same-domain subpages via
 * fieldSpotCheckSubpageCandidates) and judge its stored `phone` against the
 * FIXED context-gate rule — see the module header comment for the full
 * "found+rejected is the only route to would_reject" rationale. PURE w.r.t.
 * the DB (read-only network I/O only) — the caller decides what to do with
 * the verdict.
 */
export async function scanOnePhoneRow(
  row: { agent_id: string; phone: string; website: string | null; url: string | null },
  fetchImpl?: typeof fetch,
): Promise<PhoneRetroScanRowResult> {
  const digits = normalizePhone(row.phone);
  const homepageUrl = (row.website && row.website.trim()) || (row.url && row.url.trim()) || null;

  if (digits.length !== 8) {
    return {
      agent_id: row.agent_id,
      verdict: "unverifiable",
      reason: `stored phone "${row.phone}" does not normalise to an 8-digit shape — outside this rule's scope, not flagged`,
      homepage_url: homepageUrl,
    };
  }
  if (!homepageUrl) {
    return {
      agent_id: row.agent_id,
      verdict: "unverifiable",
      reason: "no homepage_url on file (agent_knowledge.website and agents.url both blank) — cannot re-check, not flagged",
      homepage_url: null,
    };
  }

  const rootFetched = await fetchPage(homepageUrl, {
    userAgent: "Lokal-PhoneRetroScan/1.0",
    fetchImpl,
  });
  if (!rootFetched.ok) {
    return {
      agent_id: row.agent_id,
      verdict: "unverifiable",
      reason: `homepage fetch failed (${rootFetched.reason}) — cannot confidently re-check, not flagged (fail-closed toward keeping data)`,
      homepage_url: homepageUrl,
    };
  }

  let sawClean = false;
  let sawRejectShape = false;

  // B2 fix-up (round 2 review): track whether the scan of THIS row was
  // exhaustive over every discoverable candidate page. A subpage counts as
  // "skipped" either because it failed to fetch (503/timeout/etc.) or
  // because MORE candidate links existed on the root page than
  // PHONE_RETRO_SCAN_MAX_SUBPAGES allows us to check — in either case, the
  // real/clean copy of the number might live on exactly that unreachable-
  // or-uncapped page, so a reject-shape verdict must never be allowed to
  // stand as `would_reject` when the scan wasn't exhaustive.
  let skippedSubpageCount = 0;

  const rootJudgement = judgePhoneOnPage(rootFetched.html, digits);
  if (rootJudgement === "clean") sawClean = true;
  else if (rootJudgement === "reject_shape") sawRejectShape = true;

  if (!sawClean) {
    // Ask for one MORE candidate than we'll actually fetch, purely to
    // detect whether the cap itself would drop a real candidate link (the
    // discovery helper's own maxSubpages param stops discovery silently —
    // it can't otherwise tell us a 4th link existed).
    const discovered = fieldSpotCheckSubpageCandidates(
      rootFetched.html,
      rootFetched.finalUrl || homepageUrl,
      PHONE_RETRO_SCAN_MAX_SUBPAGES + 1,
    );
    if (discovered.length > PHONE_RETRO_SCAN_MAX_SUBPAGES) {
      skippedSubpageCount += discovered.length - PHONE_RETRO_SCAN_MAX_SUBPAGES;
    }
    const subpages = discovered.slice(0, PHONE_RETRO_SCAN_MAX_SUBPAGES);
    for (const subUrl of subpages) {
      if (sawClean) break;
      const subFetched = await fetchPage(subUrl, {
        userAgent: "Lokal-PhoneRetroScan/1.0",
        fetchImpl,
      });
      if (!subFetched.ok) {
        // One dead subpage link never aborts the others, but it DOES mean
        // this row's scan is not exhaustive — the clean copy could live
        // there.
        skippedSubpageCount++;
        continue;
      }
      const subJudgement = judgePhoneOnPage(subFetched.html, digits);
      if (subJudgement === "clean") sawClean = true;
      else if (subJudgement === "reject_shape") sawRejectShape = true;
    }
  }

  if (sawClean) {
    return {
      agent_id: row.agent_id,
      verdict: "ok",
      reason: "stored phone was found cleanly (structured tel:/JSON-LD/meta source, or bounded visible text) on the root page or a followed subpage",
      homepage_url: homepageUrl,
    };
  }
  if (sawRejectShape) {
    if (skippedSubpageCount > 0) {
      return {
        agent_id: row.agent_id,
        verdict: "unverifiable",
        reason:
          `reject-shape found on checked pages but ${skippedSubpageCount} candidate subpage(s) unreachable/uncapped ` +
          `— not confirmable as would_reject (the real/clean copy of the number may live on the page(s) that ` +
          `couldn't be checked); a would_reject verdict only fires when every discoverable candidate page was ` +
          `actually checked`,
        homepage_url: homepageUrl,
      };
    }
    return {
      agent_id: row.agent_id,
      verdict: "would_reject",
      reason:
        `stored phone "${digits}" WAS found on the root page or a followed subpage, but every occurrence found is ` +
        `either inside a <script>/<style> block or welded (zero separator) onto a longer alphanumeric token — the ` +
        `exact shape the fixed context-gate rule rejects (CSS class name / JS config blob)`,
      homepage_url: homepageUrl,
    };
  }
  return {
    agent_id: row.agent_id,
    verdict: "unverifiable",
    reason:
      `stored phone "${digits}" could not be re-found anywhere reachable (root page + up to ` +
      `${PHONE_RETRO_SCAN_MAX_SUBPAGES} same-domain subpages) — absence is NOT evidence the fixed rule rejects it ` +
      `(the page may simply no longer expose it in machine-checkable text, or only appears cleanly bounded inside ` +
      `a <script>/<style> block, which is not confirmable either way), so this is left unverifiable, not flagged`,
    homepage_url: homepageUrl,
  };
}

/**
 * Blank ONE agent's `phone` to NULL and reset `verification_status` to
 * 'pending_verify' — the fix for a `would_reject` row.
 *
 * Round-4 fix (Fix A, round-3 CHANGES-REQUESTED finding: TOCTOU in the write
 * path). `expectedPhone` MUST be the exact `phone` value the would_reject
 * verdict was actually computed against (the row's `phone` from the route's
 * original batch SELECT that fed scanOnePhoneRow) — the mutation itself is
 * ONE atomic SQL compare-and-set:
 *     UPDATE agent_knowledge SET phone = NULL, verification_status = 'pending_verify'
 *      WHERE agent_id = ? AND phone = ?
 * bound to (agentId, expectedPhone). This is deliberately NOT "re-read the
 * row, compare cur.phone === expectedPhone in JS, then write" — a separate
 * read-then-write still has a gap between the two statements. Binding the
 * comparison INTO the UPDATE's own WHERE clause makes the read-check-write
 * a single indivisible SQLite statement: if any writer (e.g. the verifier
 * or a producer-facing write) changed agent_knowledge.phone for this row at
 * ANY point between the original batch SELECT and this UPDATE — including a
 * REAL phone number landing there — `changes` comes back 0 and NOTHING is
 * written: no blank, no verification_status reset, no audit row. The caller
 * gets `{ ok: false, reason: "stale_value" }` and must not treat that as an
 * error to retry blindly (the row simply needs re-scanning against its new
 * value on a future pass).
 *
 * claimed_at / curated_fields are still re-read fresh immediately before the
 * write (unchanged from before) — those are lock checks, not the value the
 * verdict was computed against, so they stay a plain re-read; only the
 * `phone` comparison itself needs to be atomic with the write.
 * Same overall transaction discipline as admin-contact-write-guard-retro-
 * sweep.ts's applyPhoneBlank.
 */
export function applyPhoneContextGateReject(
  db: ReturnType<typeof getDb>,
  agentId: string,
  expectedPhone: string,
): { ok: boolean; reason?: string } {
  try {
    const tx = db.transaction((): { ok: boolean; reason?: string } => {
      const cur = db
        .prepare(
          `SELECT a.claimed_at AS claimed_at, k.curated_fields AS curated_fields
             FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`,
        )
        .get(agentId) as { claimed_at: string | null; curated_fields: string | null } | undefined;
      if (!cur) return { ok: false, reason: "agent_not_found" };
      if (cur.claimed_at) return { ok: false, reason: "claimed_at_locked" };
      if (isPhoneFieldCurated(cur.curated_fields)) return { ok: false, reason: "curated_locked" };

      const write = db
        .prepare(
          `UPDATE agent_knowledge SET phone = NULL, verification_status = 'pending_verify'
             WHERE agent_id = ? AND phone = ?`,
        )
        .run(agentId, expectedPhone);
      if (write.changes === 0) {
        // The row's phone no longer equals what the verdict was computed
        // against — someone else wrote it concurrently. Fail closed: do NOT
        // blank whatever value is there now, and do NOT write an audit row
        // for a mutation that never happened.
        return { ok: false, reason: "stale_value" };
      }

      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'phone', ?, NULL, 'system', NULL, datetime('now'), ?)`,
      ).run(
        randomUUID(),
        agentId,
        expectedPhone,
        "phone-context-gate-retro-scan: rejected by the fixed alphanumeric-neighbour context-gate rule; verification_status reset to pending_verify",
      );
      return { ok: true };
    });
    return tx();
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as {
    dry_run?: unknown;
    limit?: unknown;
    after_agent_id?: unknown;
    cursor?: unknown;
  };
  // dry_run: true by default. The ONLY way into apply-mode is the literal
  // boolean `false` — anything else (missing, "false" the string, 0, null)
  // stays on the safe dry-run path. Same discipline as
  // admin-bm-producer-harvest.ts's own dry_run gate.
  const dryRun = body.dry_run !== false;

  // ── B2: limit/cap (mirrors admin-rfb-website-discovery.ts's own
  //    body.limit clamp — see PHONE_RETRO_SCAN_DEFAULT_LIMIT/_HARD_CAP's
  //    doc comment above for why this route needs it at all). ──
  const requestedLimit =
    typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0
      ? Math.floor(body.limit)
      : PHONE_RETRO_SCAN_DEFAULT_LIMIT;
  const effectiveLimit = Math.min(requestedLimit, PHONE_RETRO_SCAN_HARD_CAP);

  // ── B3 fix-up (round 2 review): a cursor so repeated calls make forward
  //    progress across the FULL table instead of rescanning the same top-
  //    <=HARD_CAP rows forever (ok/unverifiable rows are never mutated, so
  //    without a cursor rows beyond the cap were never reachable at all —
  //    this route could never deliver a complete one-time scan). Accepts
  //    either `after_agent_id` or `cursor` (alias); when present, only rows
  //    strictly after it (by the SAME `ORDER BY k.agent_id` the query
  //    already uses) are selected. Round-4 fix (Fix B, round-3 CHANGES-
  //    REQUESTED finding: cursor semantics): the response's `next_cursor` is
  //    the agent_id of the last row this call actually EXAMINED (scanned via
  //    scanOnePhoneRow), NOT the last row merely SELECTED by the SQL query —
  //    see the time-budget loop below for why those two can differ. A caller
  //    pages through by feeding each response's next_cursor back in as the
  //    next call's after_agent_id — together, repeated calls cover every
  //    matching row exactly once, and a row dropped purely because the time
  //    budget ran out is never skipped past: it stays selectable (agent_id >
  //    next_cursor) on the very next call. ──
  const cursorRaw = body.after_agent_id ?? body.cursor;
  const afterAgentId = typeof cursorRaw === "string" && cursorRaw.trim() !== "" ? cursorRaw.trim() : null;

  try {
    const db = getDb();

    const rows = (
      afterAgentId
        ? db
            .prepare(
              `SELECT k.agent_id AS agent_id,
                      k.phone AS phone,
                      k.website AS website,
                      a.url AS url,
                      a.claimed_at AS claimed_at,
                      k.curated_fields AS curated_fields
                 FROM agent_knowledge k
                 JOIN agents a ON a.id = k.agent_id
                WHERE k.phone IS NOT NULL AND TRIM(k.phone) != ''
                  AND k.agent_id > ?
             ORDER BY k.agent_id
                LIMIT ?`,
            )
            .all(afterAgentId, effectiveLimit)
        : db
            .prepare(
              `SELECT k.agent_id AS agent_id,
                      k.phone AS phone,
                      k.website AS website,
                      a.url AS url,
                      a.claimed_at AS claimed_at,
                      k.curated_fields AS curated_fields
                 FROM agent_knowledge k
                 JOIN agents a ON a.id = k.agent_id
                WHERE k.phone IS NOT NULL AND TRIM(k.phone) != ''
             ORDER BY k.agent_id
                LIMIT ?`,
            )
            .all(effectiveLimit)
    ) as KnowledgeRow[];

    let ok_count = 0;
    let would_reject_count = 0;
    let unverifiable_count = 0;
    let written_count = 0;
    let skipped_claimed_count = 0;
    let skipped_curated_count = 0;
    let skipped_stale_count = 0;
    let rows_scanned = 0;
    const would_reject_rows: Array<PhoneRetroScanRowResult & { write_outcome?: string }> = [];
    const errors: Array<{ agent_id: string; error: string }> = [];

    // ── B2: overall wall-clock budget across the whole scan loop — bail out
    //    early and report exactly what was (and wasn't) scanned rather than
    //    silently truncating. Mirrors admin-rfb-website-discovery.ts's own
    //    per-call time-budget loop guard. ──
    const scanStartedAt = effectivePhoneRetroScanNowMs();
    let time_budget_exceeded = false;
    const skipped_due_to_time_budget: string[] = [];

    // Fix B: the agent_id of the last row this call actually EXAMINED —
    // starts at afterAgentId (so a call that examines nothing at all, e.g.
    // the budget is already exhausted before the very first row, reports a
    // cursor that re-selects the SAME batch next time rather than skipping
    // it) and only advances when a row is actually scanned below, never for
    // a row dropped by the time budget.
    let lastExaminedAgentId: string | null = afterAgentId;

    for (const row of rows) {
      if (effectivePhoneRetroScanNowMs() - scanStartedAt >= PHONE_RETRO_SCAN_TIME_BUDGET_MS) {
        time_budget_exceeded = true;
        skipped_due_to_time_budget.push(row.agent_id);
        continue;
      }

      rows_scanned++;
      lastExaminedAgentId = row.agent_id;
      const verdict = await scanOnePhoneRow(row);
      if (verdict.verdict === "ok") {
        ok_count++;
        continue;
      }
      if (verdict.verdict === "unverifiable") {
        unverifiable_count++;
        continue;
      }

      // verdict.verdict === "would_reject"
      would_reject_count++;
      const entry: PhoneRetroScanRowResult & { write_outcome?: string } = { ...verdict };

      if (!dryRun) {
        if (row.claimed_at) {
          skipped_claimed_count++;
          entry.write_outcome = "skipped_claimed";
        } else if (isPhoneFieldCurated(row.curated_fields)) {
          skipped_curated_count++;
          entry.write_outcome = "skipped_curated";
        } else {
          // Fix A: bind the atomic compare-and-set to row.phone — the EXACT
          // value this row's would_reject verdict was computed against (the
          // original batch SELECT's own phone column, the same value fed
          // into scanOnePhoneRow above). See applyPhoneContextGateReject's
          // own doc comment for the full TOCTOU rationale.
          const result = applyPhoneContextGateReject(db, row.agent_id, row.phone);
          if (result.ok) {
            written_count++;
            entry.write_outcome = "written";
          } else if (result.reason === "claimed_at_locked") {
            skipped_claimed_count++;
            entry.write_outcome = "skipped_claimed";
          } else if (result.reason === "curated_locked") {
            skipped_curated_count++;
            entry.write_outcome = "skipped_curated";
          } else if (result.reason === "stale_value") {
            // The stored phone changed (e.g. a real number was written)
            // between the original batch SELECT and this write — the
            // concurrent value survives untouched, nothing was written, and
            // this is NOT reported as an error.
            skipped_stale_count++;
            entry.write_outcome = "skipped_stale";
          } else {
            entry.write_outcome = "error";
            errors.push({ agent_id: row.agent_id, error: result.reason ?? "unknown" });
          }
        }
      }
      would_reject_rows.push(entry);
    }

    // Fix B: next_cursor is the last row this call actually EXAMINED, not
    // the last row merely selected — see lastExaminedAgentId's own comment
    // above. When nothing was selected at all, next_cursor is explicitly
    // null (end of table reached from wherever afterAgentId already was).
    const nextCursor = rows.length > 0 ? lastExaminedAgentId : null;
    // Fix B: explicit completeness signal. reached_end_of_table is true
    // once the SELECT itself returned fewer rows than effectiveLimit (i.e.
    // there is nothing left in the table matching the WHERE clause beyond
    // this batch); scan_fully_complete additionally requires that every
    // selected row in THIS call was actually examined (the time budget
    // never cut the batch short) — a caller must treat scan_fully_complete
    // as the single source of truth for "the one-time scan is done", not
    // reached_end_of_table alone (which can be true while rows in the final
    // batch were still dropped by the time budget).
    const reached_end_of_table = rows.length < effectiveLimit;
    const scan_fully_complete = reached_end_of_table && !time_budget_exceeded;

    res.json({
      success: true,
      dry_run: dryRun,
      limit_applied: effectiveLimit,
      after_agent_id: afterAgentId,
      next_cursor: nextCursor,
      reached_end_of_table,
      scan_fully_complete,
      total_rows_selected: rows.length,
      total_rows_scanned: rows_scanned,
      time_budget_exceeded,
      skipped_due_to_time_budget,
      ok_count,
      would_reject_count,
      unverifiable_count,
      written_count,
      skipped_claimed_count,
      skipped_curated_count,
      skipped_stale_count,
      would_reject_rows,
      errors,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
