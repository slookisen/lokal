// ─── search-enrich.ts — per-producer web-search → crawl → confirm → email ────
//
// Anti-contamination enrichment for producers (agents) missing an email.
//
// Pipeline (driven by POST /admin/search-enrich, see routes/admin-search-enrich.ts):
//   1. Brave web SEARCH for the producer's name (+ city/kommune).
//   2. rank candidate result URLs by name-stem overlap.
//   3. crawl the top candidate page(s) → PageEvidence (title, emails, phones).
//   4. confirmProducerPage(): is this page REALLY this producer's? Requires a
//      hard key match (phone or orgnr = STRONG) or ≥2 soft signals (MEDIUM).
//   5. pickProducerEmail(): from a CONFIRMED page, choose the producer's own
//      contact email, rejecting directory/coordinator addresses (post@hanen.no
//      and friends) and refusing to guess when ambiguous.
//
// The decision logic (everything except braveSearch's network call) is PURE and
// unit-tested in search-enrich.test.ts. The route is a dry-run by default and
// only writes when the page is producer-confirmed by a key match AND the email
// passes pickProducerEmail.
//
// We deliberately reuse the directory/free-mail knowledge from
// cross-source-validator (single source of truth for what counts as an
// aggregator host) and extend it with a small extra hub denylist for families
// that show up as embedded coordinator emails on producer sub-pages.

import {
  isKnownDirectoryHost,
  FREE_MAIL_DOMAINS,
} from "./cross-source-validator";

// ─── name stemming ───────────────────────────────────────────────────────────

// Stopword tokens dropped from a producer name before stemming. These are the
// generic "gård / gårdsbutikk / AS / SA" words that carry no entity identity and
// would otherwise produce useless stems that match half of rural Norway.
const NAME_STOPWORDS: ReadonlySet<string> = new Set([
  "gard",
  "gaard",
  "gardsbutikk",
  "gaardsbutikk",
  "as",
  "sa",
  "og",
  "the",
  "ad",
  "da",
]);

// Strip Norwegian accents / diacritics to their ASCII base so "Nalums" and
// "Nålums" stem identically and so email local-parts (always ASCII) can be
// compared against name stems.
function stripNorwegianAccents(s: string): string {
  return s
    .replace(/å/g, "a")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/Å/g, "a")
    .replace(/Æ/g, "ae")
    .replace(/Ø/g, "o")
    // generic combining-diacritic removal for any other accented latin chars
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Produce the distinct identity stems of a producer name.
 *
 * lowercase → strip Norwegian accents → split on non-alphanumeric → drop
 * stopwords → keep tokens with length ≥ 4. For each kept token we also emit a
 * trailing-'s'-stripped variant (so possessive "nalums" also yields "nalum").
 *
 * "Nalums Gårdsbutikk" → ["nalums", "nalum"]
 */
export function nameStems(name: string): string[] {
  if (!name) return [];
  const lowered = stripNorwegianAccents(name.toLowerCase());
  // Note: stopwords are compared AFTER accent-stripping, so "gård" → "gard".
  const rawTokens = lowered.split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of rawTokens) {
    if (NAME_STOPWORDS.has(tok)) continue;
    if (tok.length < 4) continue;
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
    // trailing-'s'-stripped variant (possessive / genitive form)
    if (tok.endsWith("s")) {
      const stripped = tok.slice(0, -1);
      // keep even if stripped drops to length 3 (e.g. "nalum") — it's an
      // intentional variant of an already-accepted ≥4 token.
      if (stripped.length >= 3 && !seen.has(stripped)) {
        seen.add(stripped);
        out.push(stripped);
      }
    }
  }
  return out;
}

// ─── phone normalisation ─────────────────────────────────────────────────────

/**
 * Normalise a phone string to its last 8 significant digits (Norwegian
 * subscriber number). Keeps digits only, drops a leading "47" country code when
 * the digit run is longer than 8, then returns the last 8 digits. Returns "" if
 * there are no digits.
 */
export function normalizePhone(s: string | null | undefined): string {
  if (!s) return "";
  let digits = String(s).replace(/\D/g, "");
  if (!digits) return "";
  // Drop a leading "47" country code only when it leaves a plausible number.
  if (digits.length > 8 && digits.startsWith("47")) {
    digits = digits.slice(2);
  }
  if (digits.length <= 8) return digits;
  return digits.slice(-8);
}

// ─── page-confirmation ───────────────────────────────────────────────────────

export interface PageEvidence {
  url: string;
  title: string;
  html: string;
  emails: string[];
  phones: string[];
}

export interface StoredProducer {
  name: string;
  phone?: string | null;
  postcode?: string | null;
  street?: string | null;
  orgnr?: string | null;
  siteRoot?: string | null;
}

export interface ConfirmResult {
  confirmed: boolean;
  strength: "strong" | "medium" | "none";
  signals: string[];
}

/**
 * Decide whether `page` really belongs to `stored` (the producer we are
 * enriching). PURE.
 *
 * STRONG (any one is sufficient):
 *   - a phone on the page normalises-equal to the stored phone
 *     → signal `phone_match:<8-digit>`
 *   - stored.orgnr is present and its digits appear (digits-only) in page.html
 *     → signal `orgnr_match`
 *
 * MEDIUM (counted distinct):
 *   - a name stem of stored.name appears in page.title → `name_in_title`
 *   - stored.postcode (4-digit) appears in page.html → `postcode_on_page`
 *   - stored.street (≥4 chars, case-insensitive) appears in page.html
 *     → `street_on_page`
 *
 * confirmed = (any STRONG) OR (mediumCount ≥ 2).
 * strength  = 'strong' if any strong, else 'medium' if confirmed, else 'none'.
 */
export function confirmProducerPage(
  stored: StoredProducer,
  page: PageEvidence,
): ConfirmResult {
  const signals: string[] = [];
  let strong = false;

  // ── STRONG: phone match ──
  const storedPhone = normalizePhone(stored.phone);
  if (storedPhone) {
    for (const p of page.phones) {
      if (normalizePhone(p) === storedPhone) {
        strong = true;
        signals.push(`phone_match:${storedPhone}`);
        break;
      }
    }
  }

  // ── STRONG: orgnr match ──
  const html = page.html || "";
  const htmlDigits = html.replace(/\D/g, "");
  if (stored.orgnr) {
    const orgDigits = String(stored.orgnr).replace(/\D/g, "");
    if (orgDigits.length >= 8 && htmlDigits.includes(orgDigits)) {
      strong = true;
      signals.push("orgnr_match");
    }
  }

  // ── MEDIUM signals (counted distinct) ──
  let mediumCount = 0;

  const titleLower = stripNorwegianAccents((page.title || "").toLowerCase());
  const stems = nameStems(stored.name);
  if (stems.some((st) => titleLower.includes(st))) {
    signals.push("name_in_title");
    mediumCount++;
  }

  if (stored.postcode) {
    const pc = String(stored.postcode).replace(/\D/g, "");
    if (pc.length === 4 && new RegExp(`\\b${pc}\\b`).test(html)) {
      signals.push("postcode_on_page");
      mediumCount++;
    }
  }

  if (stored.street && stored.street.trim().length >= 4) {
    const needle = stripNorwegianAccents(stored.street.trim().toLowerCase());
    const haystack = stripNorwegianAccents(html.toLowerCase());
    if (haystack.includes(needle)) {
      signals.push("street_on_page");
      mediumCount++;
    }
  }

  const confirmed = strong || mediumCount >= 2;
  const strength: ConfirmResult["strength"] = strong
    ? "strong"
    : confirmed
      ? "medium"
      : "none";

  return { confirmed, strength, signals };
}

// ─── producer-email selection ────────────────────────────────────────────────

export interface EmailPick {
  email: string | null;
  reason: string;
}

// Extra hub/coordinator families to reject by HOST substring, beyond the
// canonical KNOWN_DIRECTORY_HOSTS set in cross-source-validator. These catch
// coordinator addresses (e.g. post@hanen.no) that are commonly embedded on a
// producer's own sub-page within an umbrella/marketplace site. Substring match
// on the full host so regional variants (e.g. bondensmarkedtroms.no) are caught.
const EXTRA_HUB_HOST_SUBSTRINGS: readonly string[] = [
  "hanen.no",
  "bondensmarked",
  "rekonorge",
  "matrike",
  "smakav",
  "matriket",
];

// Registrable domain = host's last two labels (sufficient for .no/.com/.net).
// Kept local + tiny on purpose (mirrors the prune-endpoint helper); the
// cross-source-validator's own registrableDomain is not exported.
function registrableDomainOf(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length < 2) return host.toLowerCase();
  return labels.slice(-2).join(".");
}

function hostOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const host = email.slice(at + 1).trim().toLowerCase();
  return host || null;
}

function isHubEmailHost(host: string): boolean {
  return EXTRA_HUB_HOST_SUBSTRINGS.some((sub) => host.includes(sub));
}

/**
 * Choose the producer's own contact email from the candidate emails found on a
 * CONFIRMED page. PURE.
 *
 * Process:
 *   - lowercase + dedupe.
 *   - REJECT any email whose registrable domain is a known directory host
 *     (isKnownDirectoryHost) or whose host matches a hub family substring
 *     (hanen.no, bondensmarked, rekonorge, matrike, smakav, matriket).
 *   - From the survivors, ACCEPT in priority order, returning the FIRST tier
 *     that yields a single unambiguous address:
 *       (a) registrable domain == storedSiteRoot         → reason `site_domain_match`
 *       (b) local-part contains a nameStems(name) entry   → reason `name_stem_match:<stem>`
 *       (c) registrable domain ∈ FREE_MAIL_DOMAINS        → reason `free_mail`
 *       (d) any other non-directory own-looking domain    → reason `own_domain`
 *   - If a tier has >1 DISTINCT address → `{null, 'ambiguous_multiple'}` (we
 *     only auto-pick when unambiguous within the highest-priority populated tier).
 *   - If no survivors at all → `{null, 'no_acceptable_email'}`.
 */
export function pickProducerEmail(
  emails: string[],
  producerName: string,
  storedSiteRoot?: string | null,
): EmailPick {
  // lowercase + dedupe (preserve first-seen order)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of emails) {
    if (!raw || !raw.includes("@")) continue;
    const e = raw.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    deduped.push(e);
  }

  // reject directory/coordinator/hub addresses
  const survivors = deduped.filter((e) => {
    const host = hostOfEmail(e);
    if (!host) return false;
    const root = registrableDomainOf(host);
    if (isKnownDirectoryHost(root)) return false;
    if (isHubEmailHost(host)) return false;
    return true;
  });

  if (survivors.length === 0) {
    return { email: null, reason: "no_acceptable_email" };
  }

  const siteRoot = storedSiteRoot
    ? registrableDomainOf(hostOfEmail(`x@${storedSiteRoot}`) ?? storedSiteRoot)
    : null;
  const stems = nameStems(producerName);

  // Helper: given a predicate, gather distinct matching addresses. Return a
  // resolved pick (single match), an ambiguity sentinel (>1 distinct), or null
  // (no match in this tier).
  type TierOutcome =
    | { kind: "pick"; email: string; matchedStem?: string }
    | { kind: "ambiguous" }
    | { kind: "none" };

  function tier(
    pred: (e: string, host: string, root: string) => boolean,
    stemAware = false,
  ): TierOutcome {
    const matched: string[] = [];
    let matchedStem: string | undefined;
    for (const e of survivors) {
      const host = hostOfEmail(e)!;
      const root = registrableDomainOf(host);
      if (pred(e, host, root)) {
        if (!matched.includes(e)) matched.push(e);
        if (stemAware && matchedStem === undefined) {
          const local = e.slice(0, e.lastIndexOf("@"));
          matchedStem = stems.find((st) => local.includes(st));
        }
      }
    }
    if (matched.length === 0) return { kind: "none" };
    if (matched.length > 1) return { kind: "ambiguous" };
    return { kind: "pick", email: matched[0]!, matchedStem };
  }

  // (a) own site domain
  if (siteRoot) {
    const t = tier((_e, _h, root) => root === siteRoot);
    if (t.kind === "pick") return { email: t.email, reason: "site_domain_match" };
    if (t.kind === "ambiguous") return { email: null, reason: "ambiguous_multiple" };
  }

  // (b) local-part contains a name stem
  if (stems.length > 0) {
    const t = tier((e) => {
      const local = e.slice(0, e.lastIndexOf("@"));
      return stems.some((st) => local.includes(st));
    }, true);
    if (t.kind === "pick") {
      return {
        email: t.email,
        reason: t.matchedStem ? `name_stem_match:${t.matchedStem}` : "name_stem_match",
      };
    }
    if (t.kind === "ambiguous") return { email: null, reason: "ambiguous_multiple" };
  }

  // (c) free-mail / ISP mailbox
  {
    const t = tier((_e, _h, root) => FREE_MAIL_DOMAINS.includes(root));
    if (t.kind === "pick") return { email: t.email, reason: "free_mail" };
    if (t.kind === "ambiguous") return { email: null, reason: "ambiguous_multiple" };
  }

  // (d) any other own-looking (non-directory) domain
  {
    const t = tier(() => true);
    if (t.kind === "pick") return { email: t.email, reason: "own_domain" };
    if (t.kind === "ambiguous") return { email: null, reason: "ambiguous_multiple" };
  }

  return { email: null, reason: "no_acceptable_email" };
}

// ─── Brave search ────────────────────────────────────────────────────────────

export interface BraveResult {
  title: string;
  url: string;
  description: string;
}

/**
 * Call the Brave Web Search API. Network — NOT covered by unit tests.
 * GET https://api.search.brave.com/res/v1/web/search?q=...&count=...&country=NO
 * Headers: Accept: application/json, X-Subscription-Token: <key>.
 * Parses web.results[] → {title, url, description}. Throws on non-200.
 * (Free tier is ~1 req/sec — the caller paces.)
 */
export async function braveSearch(
  query: string,
  key: string,
  count = 5,
): Promise<BraveResult[]> {
  const url =
    "https://api.search.brave.com/res/v1/web/search" +
    `?q=${encodeURIComponent(query)}` +
    `&count=${encodeURIComponent(String(count))}` +
    "&country=NO";

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Brave search failed: HTTP ${resp.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
    );
  }

  const data = (await resp.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const results = data?.web?.results ?? [];
  return results
    .filter((r) => r && typeof r.url === "string" && r.url.length > 0)
    .map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url),
      description: String(r.description ?? ""),
    }));
}

// ─── candidate ranking ───────────────────────────────────────────────────────

/**
 * Rank Brave results by how many distinct name stems appear in
 * (title + description + url), keep score > 0, sort descending, return the top 2
 * URLs. PURE.
 *
 * Hub/aggregator domains are intentionally NOT excluded here — a hub sub-page
 * that is genuinely about the producer is a fine candidate; the confirm + email
 * steps enforce safety downstream.
 */
export function rankCandidates(
  results: BraveResult[],
  producerName: string,
): string[] {
  const stems = nameStems(producerName);
  if (stems.length === 0) return [];

  const scored = results
    .map((r) => {
      const hay = stripNorwegianAccents(
        `${r.title ?? ""} ${r.description ?? ""} ${r.url ?? ""}`.toLowerCase(),
      );
      let score = 0;
      for (const st of stems) {
        if (hay.includes(st)) score++;
      }
      return { url: r.url, score };
    })
    .filter((s) => s.score > 0 && s.url);

  // stable sort: score desc, original order preserved for ties
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 2).map((s) => s.url);
}
