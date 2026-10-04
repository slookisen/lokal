// ─── Phone write guard: the number must be on its source page ───────────────
//
// W40 RFB spot-check follow-up ("write guards"): Aalan Gård got a phone number
// through the admin/auto enrichment lane (PUT /api/marketplace/agents/:id/
// knowledge with X-Admin-Key, dataSource auto — the lokal-agent-enrichment
// homepage path) with NO source_url, and the number appears nowhere on the
// producer's site — most likely invented by the routine's LLM extractor.
// Nothing on that lane ever looked at a source page before writing.
//
// This module is the shared gate for every AUTO phone write that carries an
// agent-supplied value (the two PUT knowledge endpoints + POST /admin/bulk-
// enrich): the write must name a source page (`phone_source_url`, or a
// `field_provenance.phone` record with `source_url` for that same number), the
// page is fetched server-side through the SSRF-guarded fetchPage(), and the
// number's 8 national digits must appear on it as a whole digit run
// (checkPhoneSubstantiatedBySource — the same check the weekly field
// spot-check uses, #933). Mirrors lokal#967 (admin-rfb-contact-extraction.ts,
// backfill_from_contact_email: an email is only written once it is SEEN on
// the producer's own site): same fetchPage SSRF guard, same per-host 429
// cooldown, and an unreadable page means "could not check" => NOT written.
//
// Not gated (no invented-value risk, or not an enrichment lane):
//   - owner edits (claim token / API key) — never call this;
//   - an admin write explicitly relayed from the owner (dataSource "owner",
//     or an `owner`-sourced provenance record for the same number) — CS
//     corrections from the producer's own e-mail have no source page;
//   - clearing the phone (empty string) and re-sending the stored number;
//   - server-side extractors that take the number FROM a fetched page
//     (homepage-provenance-batch, rfb contact extraction) or from Google
//     Places / Brreg — the value is the source's own, by construction.

import {
  checkAboutCandidateSubstantiatedBySource,
  type AboutSubstantiationVerdict,
} from "./about-source-substantiation";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchPage, isSafeFetchUrl } from "./fetch-page";

/** Normalize a stored phone number to 8 national digits: strip every
 *  non-digit, then strip a leading 0047/47 country code when exactly 8
 *  digits remain. Returns null when the value doesn't normalize to 8 digits
 *  (caller then falls back to the text check). PURE. Exported for tests. */
export function normalizePhoneToNationalDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (/^\d{8}$/.test(digits)) return digits;
  const m = /^(?:0047|47)(\d{8})$/.exec(digits);
  return m ? m[1]! : null;
}

/** Phone-specific substantiation: the text-based default false-mismatches
 *  on formatting differences ("+47 41 63 44 22" vs "41634422"). Collapses
 *  separators (space/nbsp/dot/dash/parentheses/+) between digits on the page
 *  text, then requires the 8 national digits to be a WHOLE digit run —
 *  optionally prefixed by a 47/0047 country code — so a number embedded in
 *  a longer digit run (ids, other numbers) never matches. Falls back to the
 *  standard text check when the stored value isn't an 8-digit number. PURE.
 *  Exported for tests. */
export function checkPhoneSubstantiatedBySource(
  candidate: string | null | undefined,
  sourceText: string | null | undefined,
): AboutSubstantiationVerdict {
  const national = normalizePhoneToNationalDigits(candidate);
  if (!national) return checkAboutCandidateSubstantiatedBySource(candidate, sourceText);
  const collapsed = (sourceText || "").replace(/(\d)[ \t\u00a0.\-()+]+(?=\d)/g, "$1");
  for (const run of collapsed.match(/\d+/g) || []) {
    if (run === national || run === "47" + national || run === "0047" + national) {
      return { substantiated: true, reason: `phone ${national} found on page (digits normalized)` };
    }
  }
  return { substantiated: false, reason: `phone ${national} not found on page as a whole 8-digit number` };
}


// ── Source-url resolution ────────────────────────────────────────────────────

/** Same national-number identity used everywhere below: 8 national digits
 *  when the value normalizes, else the whitespace-free lowercased string. */
function phoneIdentity(value: string): string {
  return normalizePhoneToNationalDigits(value) ?? value.replace(/\s+/g, "").toLowerCase();
}

/** The records of one provenance field, in either wire shape the knowledge
 *  endpoints accept (flat array, or `{ sources: [...] }`). */
function provenanceRecords(fieldProv: unknown): Record<string, unknown>[] {
  const list: unknown[] = Array.isArray(fieldProv)
    ? fieldProv
    : fieldProv && typeof fieldProv === "object" && Array.isArray((fieldProv as { sources?: unknown }).sources)
      ? (fieldProv as { sources: unknown[] }).sources
      : [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

function recordValue(r: Record<string, unknown>): string | null {
  const v = typeof r.value === "string" ? r.value : typeof r.raw_value === "string" ? r.raw_value : null;
  return v && v.trim() ? v : null;
}

function recordHead(r: Record<string, unknown>): string {
  return String(r.source_type ?? "").trim().toLowerCase().split(":")[0]!;
}

/** The source page a phone write names: an explicit `phone_source_url`
 *  first, else the `source_url` of a `field_provenance.phone` record whose
 *  value is this same number (or that carries no value). PURE. */
export function findPhoneSourceUrl(
  phone: string,
  opts: { explicitSourceUrl?: unknown; fieldProvenancePhone?: unknown },
): string | null {
  if (typeof opts.explicitSourceUrl === "string" && opts.explicitSourceUrl.trim()) {
    return opts.explicitSourceUrl.trim();
  }
  const want = phoneIdentity(phone);
  for (const r of provenanceRecords(opts.fieldProvenancePhone)) {
    const url = typeof r.source_url === "string" ? r.source_url.trim() : "";
    if (!url) continue;
    const v = recordValue(r);
    if (v === null || phoneIdentity(v) === want) return url;
  }
  return null;
}

/** True when the incoming phone provenance has an `owner` record for this
 *  same number (a CS relay of the producer's own statement). PURE. */
export function hasOwnerPhoneProvenance(phone: string, fieldProvenancePhone: unknown): boolean {
  const want = phoneIdentity(phone);
  return provenanceRecords(fieldProvenancePhone).some((r) => {
    const v = recordValue(r);
    return recordHead(r) === "owner" && v !== null && phoneIdentity(v) === want;
  });
}

/** `fieldProvenancePhone` without the records for `phone` — used when that
 *  number's column write is refused, so its unproven provenance claim is not
 *  merged either (bad provenance poisons the cross-source verifier). Keeps
 *  the wire shape it was given. PURE. */
export function withoutPhoneProvenanceFor(fieldProvenancePhone: unknown, phone: string): unknown {
  const want = phoneIdentity(phone);
  const keep = (r: unknown) => {
    if (!r || typeof r !== "object") return true;
    const v = recordValue(r as Record<string, unknown>);
    return v === null ? false : phoneIdentity(v) !== want;
  };
  if (Array.isArray(fieldProvenancePhone)) return fieldProvenancePhone.filter(keep);
  if (
    fieldProvenancePhone &&
    typeof fieldProvenancePhone === "object" &&
    Array.isArray((fieldProvenancePhone as { sources?: unknown }).sources)
  ) {
    return {
      ...(fieldProvenancePhone as object),
      sources: (fieldProvenancePhone as { sources: unknown[] }).sources.filter(keep),
    };
  }
  return fieldProvenancePhone;
}

// ── Fetch + verdict ──────────────────────────────────────────────────────────

export type PhoneWriteOutcome =
  /** number seen on the named source page — write allowed */
  | "verified"
  /** not checked, write allowed: same number as stored / clearing / owner relay */
  | "unchanged"
  | "cleared"
  | "owner_relay"
  /** write refused */
  | "rejected_no_source_url"
  | "rejected_source_url_invalid"
  | "rejected_not_on_source_page"
  | "fetch_failed"
  | "cooldown_skipped";

export interface PhoneWriteVerdict {
  allowed: boolean;
  outcome: PhoneWriteOutcome;
  source_url: string | null;
  /** final URL after redirects, when the page was read */
  checked_url?: string;
  detail?: string;
}

const PHONE_GUARD_USER_AGENT = "Lokal-RFB-PhoneGuard/1.0 (+https://rettfrabonden.com)";

// Per-host cooldown on a 429 — mirrors RFB_CX_COOLDOWN_MS (lokal#967): a
// rate-limited host is parked for this long so a whole enrichment run does
// not hammer it again; writes for that host come back `cooldown_skipped`.
const PHONE_GUARD_COOLDOWN_MS = 5 * 60 * 1000;
const phoneGuardHostCooldownUntil = new Map<string, number>();

let fetchImplForTesting: typeof fetch | null = null;
/** Test-only: route the guard's page fetches through a stub. */
export function __setPhoneGuardFetchImplForTesting(impl: typeof fetch | null): void {
  fetchImplForTesting = impl;
}
/** Test-only. */
export function __resetPhoneGuardCooldownForTesting(): void {
  phoneGuardHostCooldownUntil.clear();
}

function hostOf(url: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Fetch `sourceUrl` and check `phone` is on it. Never throws. */
export async function verifyPhoneOnSourcePage(phone: string, sourceUrl: string | null): Promise<PhoneWriteVerdict> {
  if (!sourceUrl) return { allowed: false, outcome: "rejected_no_source_url", source_url: null };
  const host = hostOf(sourceUrl);
  if (!/^https?:\/\//i.test(sourceUrl) || !host || !isSafeFetchUrl(sourceUrl)) {
    return { allowed: false, outcome: "rejected_source_url_invalid", source_url: sourceUrl };
  }
  const until = phoneGuardHostCooldownUntil.get(host);
  if (until !== undefined && until > Date.now()) {
    return { allowed: false, outcome: "cooldown_skipped", source_url: sourceUrl, detail: host };
  }
  let result;
  try {
    result = await fetchPage(sourceUrl, {
      userAgent: PHONE_GUARD_USER_AGENT,
      timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
      ...(fetchImplForTesting ? { fetchImpl: fetchImplForTesting } : {}),
    });
  } catch (err) {
    return { allowed: false, outcome: "fetch_failed", source_url: sourceUrl, detail: String((err as Error)?.message ?? err).slice(0, 80) };
  }
  if (!result.ok) {
    if (result.reason === "http_429") phoneGuardHostCooldownUntil.set(host, Date.now() + PHONE_GUARD_COOLDOWN_MS);
    return { allowed: false, outcome: "fetch_failed", source_url: sourceUrl, detail: result.reason };
  }
  // Raw HTML on purpose: a number that is only in a `tel:` link is still on
  // the page; checkPhoneSubstantiatedBySource requires a WHOLE digit run, so
  // a number inside a longer id never matches.
  const verdict = checkPhoneSubstantiatedBySource(phone, result.html);
  return verdict.substantiated
    ? { allowed: true, outcome: "verified", source_url: sourceUrl, checked_url: result.finalUrl, detail: verdict.reason }
    : { allowed: false, outcome: "rejected_not_on_source_page", source_url: sourceUrl, checked_url: result.finalUrl, detail: verdict.reason };
}

/**
 * The full decision for one AUTO-lane phone write. `phone` is the incoming
 * column value; `existingPhone` the stored one. Clearing, re-sending the
 * stored number and owner relays are allowed without a fetch; everything
 * else needs a named source page that shows the number.
 */
export async function guardAutoPhoneWrite(opts: {
  phone: string;
  existingPhone: string | null | undefined;
  explicitSourceUrl?: unknown;
  fieldProvenancePhone?: unknown;
  ownerRelay?: boolean;
}): Promise<PhoneWriteVerdict> {
  const phone = opts.phone;
  if (!phone.trim()) return { allowed: true, outcome: "cleared", source_url: null };
  const existing = (opts.existingPhone ?? "").trim();
  if (existing && phoneIdentity(existing) === phoneIdentity(phone)) {
    return { allowed: true, outcome: "unchanged", source_url: null };
  }
  if (opts.ownerRelay || hasOwnerPhoneProvenance(phone, opts.fieldProvenancePhone)) {
    return { allowed: true, outcome: "owner_relay", source_url: null };
  }
  const sourceUrl = findPhoneSourceUrl(phone, {
    explicitSourceUrl: opts.explicitSourceUrl,
    fieldProvenancePhone: opts.fieldProvenancePhone,
  });
  return verifyPhoneOnSourcePage(phone, sourceUrl);
}
