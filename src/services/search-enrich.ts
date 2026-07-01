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
  DISTINCTIVE_SPECIALIST_TOKENS,
  BENIGN_BUSINESS_TOKENS,
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
  /**
   * Visible page text (script/style/tags stripped, whitespace collapsed, capped
   * ~20k chars), extracted by extractVisibleText() from the SAME already-fetched
   * html. Populated by buildPageEvidence(); used downstream to extract CONTENT
   * (business-type / product / about) from a CONFIRMED producer homepage so
   * profile content comes from the producer's own site rather than google_places.
   */
  contentText?: string;
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

// ─── Crawl layer (orchestrator-pr-12) ───────────────────────────────────────
//
// MOVED here from routes/admin-search-enrich.ts so the same crawl path can be
// the default `crawl` dependency for BOTH the inline route and the background
// sweep. The SSRF guard + same-host /kontakt + /om-oss behaviour are preserved
// EXACTLY as in the route (do not weaken them).

const FETCH_TIMEOUT_MS = 8_000;
const UA = "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)";

/** Collect ALL candidate emails from HTML (mailto: links first, then bare). */
export function extractEmails(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (e: string) => {
    const lc = e.toLowerCase();
    if (!seen.has(lc)) {
      seen.add(lc);
      out.push(lc);
    }
  };
  const mailtoRe = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(html)) !== null) push(m[1]!);
  const bareRe = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  while ((m = bareRe.exec(html)) !== null) push(m[1]!);
  return out;
}

/** Normalise a Norwegian phone to 8 digits (mirrors marketplace.normalisePhone). */
function normalisePhoneHtml(raw: string): string {
  return raw
    .replace(/^\+47/, "")
    .replace(/^0047/, "")
    .replace(/^\+/, "")
    .replace(/[\s\-().]/g, "")
    .replace(/\D/g, "");
}

/** Collect ALL candidate phone numbers from HTML (mirrors marketplace.extractPhone). */
export function extractPhones(html: string): string[] {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  const re = /(?:\+47|0047|47[\s\-])?(\d{2}[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{2})\b/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = normalisePhoneHtml(m[0]);
    if (digits.length === 8 && !/^(\d)\1{7}$/.test(digits) && !seen.has(digits)) {
      seen.add(digits);
      out.push(digits);
    }
  }
  return out;
}

/** Extract a page title from <title> or og:title. */
export function extractTitle(html: string): string {
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og && og[1]) return og[1].trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1]) return t[1].replace(/\s+/g, " ").trim();
  return "";
}

// ─── homepage CONTENT extraction (PR-A, 2026-06-16) ──────────────────────────
//
// PURE functions that extract the producer's OWN content from the confirmed
// homepage HTML the crawler already fetched. Today's customer complaints are
// because profile content (about / products / categories / business-type) is
// taken from google_places, not the producer's homepage — so Ingunnshage shows
// as "hagekonsulent" not a "besøkshage", Grette as a meat producer not an
// andelslandbruk (vegetables), Fløy Bakeri lists "lefser" it does not make, and
// Bomstad shows shrimp not goat. These extractors give the writer a HOMEPAGE
// source for content so it can be PREFERRED over google_places. No LLM, no new
// network — they read the same `html`/`contentText` the crawler already has, and
// only run on a CONFIRMED producer page (provenance guaranteed by the caller).

/**
 * Strip a page to its visible text: drop <script>/<style>/<noscript>/<template>
 * blocks, remove all remaining tags, decode the handful of entities the contact
 * extractors already special-case, collapse whitespace, and cap at ~20k chars so
 * a huge page can't blow up downstream token scans. PURE.
 */
export function extractVisibleText(html: string): string {
  if (!html) return "";
  let h = html;
  // Drop non-visible blocks entirely (content inside them is never page copy).
  h = h
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ");
  // Strip remaining tags, decode common entities, collapse whitespace.
  const text = h
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&aelig;/gi, "æ").replace(/&oslash;/gi, "ø").replace(/&aring;/gi, "å")
    .replace(/&AElig;/g, "Æ").replace(/&Oslash;/g, "Ø").replace(/&Aring;/g, "Å")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 20_000);
}

// Norwegian → category vocabulary, mirroring the platform's canonical map in
// services/marketplace-registry.ts (categoryMap) and routes/seo.ts
// (CATEGORY_MAP). Kept local (dependency-free, accent-stripped at match time)
// so this module stays a leaf importer of cross-source-validator only. The 10
// category keys MUST match the platform set: vegetables, fruit, berries, dairy,
// eggs, meat, fish, bread, honey, herbs.
const CONTENT_CATEGORY_LEXICON: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["vegetables", [
    "gronnsaker", "gronnsak", "gront", "vegetables", "poteter", "potet",
    "gulrotter", "gulrot", "lok", "kal", "tomat", "tomater", "agurk",
    "brokkoli", "blomkal", "squash", "paprika", "selleri", "purre", "spinat",
    "salat", "reddik", "gresskar", "mais", "erter", "bonner", "rodbeter",
    "nepe", "pastinakk", "andelslandbruk",
  ]],
  ["fruit", [
    "frukt", "fruit", "epler", "eple", "parer", "pare", "plommer", "plomme",
    "kirsebar", "moreller", "rips", "stikkelsbar", "druer",
  ]],
  ["berries", [
    "bar", "berries", "jordbar", "blabar", "bringebar", "tyttebar",
    "solbar", "multe", "multer", "markjordbar",
  ]],
  ["dairy", [
    "meieri", "dairy", "melk", "ost", "smor", "yoghurt", "flote", "romme",
    "brunost", "hvitost", "geitost", "pultost", "gamalost", "smoreost",
    "ysteri", "ysteriet",
  ]],
  ["eggs", ["egg", "eggs", "frittgaende"]],
  ["meat", [
    "kjott", "meat", "lam", "lammekjott", "svin", "svinekjott", "storfe",
    "storfekjott", "kylling", "vilt", "elg", "hjort", "rein", "reinsdyr",
    "polser", "spekemat", "fenalar", "ribbe", "pinnekjott", "geit", "geitekjott",
  ]],
  ["fish", [
    "fisk", "fish", "sjomat", "laks", "torsk", "reker", "krabbe", "blaskjell",
    "orret", "roye", "sei", "hyse", "kveite", "steinbit", "torrfisk",
    "klippfisk", "lutefisk", "rakfisk", "gravlaks",
  ]],
  ["bread", [
    "brod", "bread", "bakervarer", "bakeri", "lefse", "lefser", "flatbrod",
    "rundstykker", "boller", "kanelboller", "surdeig", "grovbrod",
  ]],
  ["honey", ["honning", "honey", "birokt"]],
  ["herbs", ["urter", "herbs", "krydder", "dill", "persille", "basilikum", "timian"]],
];

/**
 * Detect distinctive Norwegian BUSINESS-TYPE tokens that appear in the page
 * text. Reuses the curated lexicon from cross-source-validator
 * (DISTINCTIVE_SPECIALIST_TOKENS plus the gård-family BENIGN_BUSINESS_TOKENS),
 * matched on accent-stripped, word-boundary terms. Returns the distinct tokens
 * found, in lexicon order. Small curated lexicon — NO LLM. PURE.
 *
 * This is the signal that fixes the wrong-business-type complaints: a page that
 * says "besøkshage" / "andelslandbruk" / "ysteri" tells the writer the real
 * business type so it can override a wrong google_places category.
 */
export function extractBusinessTypeTokens(text: string): string[] {
  if (!text) return [];
  const hay = stripNorwegianAccents(text.toLowerCase());
  const out: string[] = [];
  const seen = new Set<string>();
  // DISTINCTIVE first (high-signal), then BENIGN gård-family (low-signal but
  // still useful provenance that the page is a farm's own site).
  for (const set of [DISTINCTIVE_SPECIALIST_TOKENS, BENIGN_BUSINESS_TOKENS]) {
    for (const tok of set) {
      if (seen.has(tok)) continue;
      // Whole-word match (tokens are already accent-stripped/lowercase).
      const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(hay)) {
        seen.add(tok);
        out.push(tok);
      }
    }
  }
  return out;
}

/**
 * Match product/category nouns in the page text against the platform's category
 * vocabulary and return the NORMALIZED category hits (e.g. "vegetables",
 * "meat"), in canonical order, deduped. Word-boundary, accent-stripped matching
 * mirrors marketplace-registry's category detection. PURE.
 *
 * "vi dyrker grønnsaker i vårt andelslandbruk" → ["vegetables"]
 * "ferskt geitekjøtt fra egen gård"            → ["meat"]
 */
export function extractProductMentions(text: string): string[] {
  if (!text) return [];
  const hay = stripNorwegianAccents(text.toLowerCase());
  const out: string[] = [];
  for (const [category, keywords] of CONTENT_CATEGORY_LEXICON) {
    for (const kw of keywords) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(hay)) {
        if (!out.includes(category)) out.push(category);
        break; // one hit is enough to include the category
      }
    }
  }
  return out;
}

/**
 * Produce a DETERMINISTIC extractive "about" summary from the page HTML:
 *   1. prefer og:description, else <meta name="description">,
 *   2. else the first meaningful visible paragraph (≥40 chars) of body text.
 * Whitespace-collapsed, decoded, capped at ~300 chars (cut on a word boundary).
 * No generative text — purely extractive. PURE.
 */
export function summarizeAbout(html: string): string {
  if (!html) return "";
  const cap = (s: string): string => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length <= 300) return t;
    const slice = t.slice(0, 300);
    const lastSpace = slice.lastIndexOf(" ");
    return (lastSpace > 200 ? slice.slice(0, lastSpace) : slice).trim();
  };
  const decode = (s: string): string =>
    s
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&aelig;/gi, "æ").replace(/&oslash;/gi, "ø").replace(/&aring;/gi, "å")
      .replace(/&AElig;/g, "Æ").replace(/&Oslash;/g, "Ø").replace(/&Aring;/g, "Å")
      .replace(/&quot;/gi, '"').replace(/&#39;/g, "'");

  // (1) og:description (property OR name, attribute order tolerant).
  const ogContentFirst = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:description["']/i,
  );
  const ogPropFirst = html.match(
    /<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  );
  const og = ogPropFirst?.[1] ?? ogContentFirst?.[1];
  if (og && og.trim()) return cap(decode(og));

  // (2) <meta name="description">.
  const mdPropFirst = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  );
  const mdContentFirst = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
  );
  const md = mdPropFirst?.[1] ?? mdContentFirst?.[1];
  if (md && md.trim()) return cap(decode(md));

  // (3) first meaningful visible paragraph of body text.
  const visible = extractVisibleText(html);
  if (!visible) return "";
  // Split into sentence-ish chunks and take the first that is substantive.
  for (const chunk of visible.split(/(?<=[.!?])\s+/)) {
    const c = chunk.trim();
    if (c.length >= 40) return cap(c);
  }
  // Fallback: the leading slice of visible text.
  return cap(visible);
}

// ─── homepage CONTENT → platform write helpers (PR-24a, 2026-06-16) ──────────
//
// PURE helpers that turn the raw extractor output (extractProductMentions /
// extractBusinessTypeTokens / summarizeAbout) into something the writer can
// safely PUT as website_homepage-sourced content over a wrong google_places
// value. Two concerns:
//   1. mapToPlatformCategories — collapse the extractor's category keys + the
//      distinctive business-type tokens onto the PLATFORM's category vocabulary
//      (the 12-key set the `agents.categories` column + /sok filter use), so the
//      categories we write match what discovery understands.
//   2. meetsAboutQualityBar — the gate the writer applies before writing an
//      about/description: only a substantive, Norwegian, non-boilerplate summary
//      is good enough to overwrite a value (a thin/cookie-banner/English snippet
//      is worse than the existing one, so we keep the old one and skip).
// Both are exported and unit-tested in search-enrich.test.ts. NO LLM, NO I/O.

/**
 * The platform's category vocabulary — the canonical keys the `agents.categories`
 * column stores and the /sok category filter understands. MUST stay aligned with
 * routes/seo.ts CATEGORY_LABELS_NO + services/marketplace-registry.ts categoryMap.
 * `other` is the catch-all when a producer is clearly a food producer but no
 * specific category matched (kept last; only used as a fallback, never mixed in).
 */
export const PLATFORM_CATEGORIES: readonly string[] = [
  "meat", "dairy", "vegetables", "fruit", "bakery", "beverages",
  "honey", "eggs", "fish", "preserves", "herbs", "other",
];

// extractProductMentions() returns the search-enrich lexicon's own category
// keys (which include "bread" and "berries"); map those onto the platform
// vocabulary above. "bread" → "bakery"; "berries" → "fruit" (the platform set
// has no separate berries key — berries are sold under fruit). Everything else
// is already a platform key and passes through unchanged.
const PRODUCT_KEY_TO_PLATFORM: Readonly<Record<string, string>> = {
  vegetables: "vegetables",
  fruit: "fruit",
  berries: "fruit",
  dairy: "dairy",
  eggs: "eggs",
  meat: "meat",
  fish: "fish",
  bread: "bakery",
  honey: "honey",
  herbs: "herbs",
};

// Distinctive business-type tokens (from extractBusinessTypeTokens) → the
// platform category they imply. This is what fixes the wrong-business-type
// complaints: a page that says "andelslandbruk" is a VEGETABLE producer (not
// meat), a "ysteri"/"meieri" is dairy, a "bakeri" is bakery, a "bryggeri"/
// "brenneri"/"vingård" is beverages, a "slakteri" is meat, a "gartneri" is
// vegetables. Tokens that carry no clean food category (besøkshage,
// hagekonsulent, kafe, kro, the gård-family benign tokens, generic "mat"/"bruk")
// are intentionally absent — they contribute no category. "frukt"/"fisk"/"kjøtt"
// as business-type words map to the obvious category too.
const BUSINESS_TOKEN_TO_PLATFORM: Readonly<Record<string, string>> = {
  ysteri: "dairy", ysteriet: "dairy", meieri: "dairy", meieriet: "dairy",
  bakeri: "bakery", bakeriet: "bakery",
  bryggeri: "beverages", bryggeriet: "beverages",
  brenneri: "beverages", brenneriet: "beverages",
  vingard: "beverages", vingaard: "beverages",
  slakteri: "meat", kjott: "meat",
  gartneri: "vegetables", andelslandbruk: "vegetables",
  fisk: "fish",
  frukt: "fruit",
};

/**
 * Map raw extractor output to the PLATFORM category vocabulary. PURE.
 *
 * Combines the product-mention category hits (extractProductMentions) and the
 * distinctive business-type tokens (extractBusinessTypeTokens) into a deduped,
 * canonical-order list of platform categories. Returns [] when nothing maps
 * (the writer then leaves `categories` untouched — never writes a guess).
 *
 * Order is PLATFORM_CATEGORIES order so the result is deterministic regardless
 * of input order. "other" is NEVER auto-added here (it is a human/catch-all
 * value, not something we infer from a homepage).
 *
 * Examples (the live complaints):
 *   Grette : products=[vegetables], tokens=[andelslandbruk] → ["vegetables"]
 *   Fløy   : products=[bread],      tokens=[bakeri]         → ["bakery"]
 *   Bomstad: products=[meat,dairy], tokens=[]               → ["meat","dairy"]
 */
export function mapToPlatformCategories(
  productMentions: readonly string[],
  businessTypeTokens: readonly string[] = [],
): string[] {
  const hits = new Set<string>();
  for (const p of productMentions) {
    const mapped = PRODUCT_KEY_TO_PLATFORM[p];
    if (mapped) hits.add(mapped);
  }
  for (const t of businessTypeTokens) {
    const mapped = BUSINESS_TOKEN_TO_PLATFORM[t];
    if (mapped) hits.add(mapped);
  }
  // Emit in canonical platform order (drop the "other" catch-all — never inferred).
  return PLATFORM_CATEGORIES.filter((c) => c !== "other" && hits.has(c));
}

// Generic boilerplate that is NOT a real "about" — cookie/consent banners,
// navigation chrome, placeholder copy. If the candidate summary is dominated by
// one of these, it is worse than whatever we already have, so we skip the write.
// Accent-stripped, lowercase substrings.
const GENERIC_ABOUT_MARKERS: readonly string[] = [
  "cookie", "informasjonskapsler", "samtykke", "personvern",
  "lorem ipsum", "javascript", "aktiver javascript",
  "siden er under", "under construction", "kommer snart", "coming soon",
  "all rights reserved", "alle rettigheter",
];

// Letters that signal the text is Norwegian (or at least Scandinavian) prose
// rather than an English/other-language snippet: the æ/ø/å family plus a small
// set of very common Norwegian function words. The homepage content we want to
// surface is Norwegian; an English cookie/marketing blurb should NOT overwrite a
// producer's about. PURE check, no network, no language library.
const NORWEGIAN_WORD_MARKERS: readonly string[] = [
  " og ", " er ", " på ", " vi ", " med ", " for ", " til ", " som ",
  " av ", " har ", " vår ", " våre ", " gård", " fra ",
];

/**
 * Quality bar a candidate `about`/`description` summary must clear before the
 * writer is allowed to overwrite an existing value with it. PURE.
 *
 * Requires ALL of:
 *   - length ≥ 80 chars (a real description, not a tagline/fragment),
 *   - contains no Unicode replacement character (a corrupted/truncated-
 *     mid-character upstream fetch — e.g. "p�" instead of "på"),
 *   - looks Norwegian — contains an æ/ø/å letter OR a common Norwegian function
 *     word (rejects an English cookie/marketing snippet),
 *   - is NOT dominated by generic boilerplate (cookie/consent/placeholder).
 *
 * Returns false for empty/short/foreign/boilerplate text so the caller keeps the
 * existing value (blank or stale beats wrong). minLen is overridable for tests.
 */
export function meetsAboutQualityBar(text: string | null | undefined, minLen = 80): boolean {
  if (!text) return false;
  const trimmed = String(text).replace(/\s+/g, " ").trim();
  if (trimmed.length < minLen) return false;

  // Reject text containing the Unicode replacement character — a definitive
  // sign of a byte-level truncation/encoding corruption upstream (cuts a
  // multi-byte Norwegian character in half, e.g. "p�" instead of "på").
  // A corrupted string should never pass the quality bar even if otherwise
  // long/Norwegian/non-boilerplate.
  if (trimmed.includes("�")) return false;

  const lower = trimmed.toLowerCase();
  const lowerAscii = stripNorwegianAccents(lower);

  // Reject boilerplate (cookie/consent/placeholder dominates the snippet).
  for (const marker of GENERIC_ABOUT_MARKERS) {
    if (lowerAscii.includes(marker)) return false;
  }

  // Must look Norwegian: an æ/ø/å letter, OR a common Norwegian function word.
  // (Pad with spaces so word-markers match at the string edges too.)
  const hasNordicLetter = /[æøåÆØÅ]/.test(trimmed);
  const padded = ` ${lower} `;
  const hasNorwegianWord = NORWEGIAN_WORD_MARKERS.some((w) => padded.includes(w));
  if (!hasNordicLetter && !hasNorwegianWord) return false;

  return true;
}

// ─── EXPERIENCES vertical: homepage CONTENT → experience-category mapper ──────
//
// orch-experiences-content-refresh (2026-06-17). The experiences vertical
// (opplevagent.no, experiences.db) classifies things-to-do by ACTIVITY, not by
// food product — so the food-oriented mapToPlatformCategories() above is the
// WRONG vocabulary for it. This mapper is its experiences-vertical twin: it
// turns a provider's own homepage visible text into the experiences-DB category
// SLUGS that `experiences.category` stores and `/api/opplevelser/discover?category=`
// filters on. PURE — no LLM, no I/O. Reuses extractVisibleText/summarizeAbout/
// meetsAboutQualityBar (above) unchanged; only the category vocabulary differs.
//
// The slug set MUST match what the experiences harvest/seed already writes (see
// experiences-openapi.ts + the exp-store fixtures: dyreliv_safari, natur_friluft,
// kultur_historie, …). Kept here as a leaf, dependency-free lexicon so the
// experiences endpoint can REUSE this module rather than duplicating extractors.

/**
 * The experiences-vertical category vocabulary — the canonical slugs the
 * `experiences.category` column stores and the `/api/opplevelser/discover`
 * category filter understands. Aligned with the harvest/seed slugs documented
 * in experiences-openapi.ts and exercised by the exp-store fixtures.
 */
export const EXPERIENCE_CATEGORIES: readonly string[] = [
  "natur_friluft",     // hiking, kayak, climbing, glacier, outdoor nature
  "dyreliv_safari",    // whale/bird/wildlife safaris, animal encounters
  "vannaktivitet",     // water-based: rafting, diving, fishing trips, boat
  "vinteraktivitet",   // winter: ski, dog-sled, snowmobile, northern lights
  "kultur_historie",   // museums, guided town/heritage walks, history
  "mat_drikke",        // food/drink experiences, tastings, breweries, courses
  "gardsbesok",        // farm visits, petting farms, gård experiences
  "wellness_spa",      // spa, sauna, yoga, retreat, wellness
];

// Norwegian (accent-stripped, word-boundary) keyword → experience-category slug.
// Curated, small, deterministic. A page that says "hvalsafari" is dyreliv_safari;
// "brevandring"/"fjelltur" is natur_friluft; "rafting"/"kajakk" is vannaktivitet;
// "hundekjoring"/"nordlys" is vinteraktivitet; "museum"/"byvandring" is
// kultur_historie; "olsmaking"/"bryggeri"/"matkurs" is mat_drikke; "gardsbesok"/
// "besoksgard" is gardsbesok; "spa"/"sauna"/"yoga" is wellness_spa.
const EXPERIENCE_CATEGORY_LEXICON: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["natur_friluft", [
    "friluft", "friluftsliv", "fjelltur", "fjelltmarsj", "vandring", "vandretur",
    "fottur", "tur i naturen", "naturopplevelse", "brevandring", "isbre", "isbreen",
    "klatring", "klatretur", "via ferrata", "topptur", "sykkeltur", "terrengsykling",
    "padletur", "natursti", "hiking", "trekking", "glacier",
  ]],
  ["dyreliv_safari", [
    "hvalsafari", "hval", "safari", "dyreliv", "fuglesafari", "fugletitting",
    "selsafari", "moskussafari", "elgsafari", "dyrepark", "wildlife", "whale",
  ]],
  ["vannaktivitet", [
    "rafting", "elvepadling", "kajakk", "kajakktur", "kano", "kanotur", "padling",
    "dykking", "snorkling", "fisketur", "havfiske", "deepseafishing", "rib", "ribtur",
    "bottur", "seiltur", "stand up paddle", "sup", "rafting",
  ]],
  ["vinteraktivitet", [
    "hundekjoring", "hundeslede", "sledehund", "snoskuter", "snowmobile",
    "skitur", "langrenn", "telemark", "truger", "trugetur", "nordlys",
    "nordlystur", "aurora", "northern lights", "skigaring", "vinteraktivitet",
  ]],
  ["kultur_historie", [
    "museum", "museet", "byvandring", "guidet tur", "historie", "historisk",
    "kulturminne", "kulturarv", "stavkirke", "festning", "krigshistorie",
    "kulturopplevelse", "kunst", "galleri", "heritage", "city walk",
  ]],
  ["mat_drikke", [
    "olsmaking", "vinsmaking", "smaking", "bryggeri", "bryggerier", "brenneri",
    "destilleri", "matkurs", "matopplevelse", "kortreist mat", "gardsmat",
    "ysteri", "ostesmaking", "food tour", "matvandring", "kafe", "restaurantbesok",
  ]],
  ["gardsbesok", [
    "gardsbesok", "besoksgard", "besoeksgaard", "gardsopplevelse", "dyra pa garden",
    "kose med dyr", "gardsdyr", "ridning", "rideskole", "ridetur", "ponniridning",
    "farm visit", "petting",
  ]],
  ["wellness_spa", [
    "spa", "wellness", "sauna", "badstu", "yoga", "retreat", "massasje",
    "velvaere", "velvere", "avslapning", "meditasjon", "isbad",
  ]],
];

/**
 * Map a provider's homepage VISIBLE TEXT to the experiences-vertical category
 * slugs. PURE — accent-stripped, word-boundary matching over the curated
 * EXPERIENCE_CATEGORY_LEXICON. Returns the matched slugs in EXPERIENCE_CATEGORIES
 * canonical order (deterministic regardless of input order), deduped. Returns []
 * when nothing maps so the writer never writes a guessed category.
 *
 *   "Bli med på hvalsafari fra Tromsø"            → ["dyreliv_safari"]
 *   "Brevandring på Folgefonna og fjelltur"       → ["natur_friluft"]
 *   "Rafting i Sjoa — elvepadling for hele familien" → ["vannaktivitet"]
 *   "Hundekjøring under nordlyset"                → ["vinteraktivitet"]
 *   "Vi tilbyr overnatting og parkering"          → []
 */
export function mapToExperienceCategories(text: string | null | undefined): string[] {
  if (!text) return [];
  const hay = stripNorwegianAccents(String(text).toLowerCase());
  const hits = new Set<string>();
  for (const [slug, keywords] of EXPERIENCE_CATEGORY_LEXICON) {
    for (const kw of keywords) {
      const norm = stripNorwegianAccents(kw.toLowerCase());
      // Multi-word phrases: substring match; single tokens: word-boundary match.
      const matched = norm.includes(" ")
        ? hay.includes(norm)
        : new RegExp(`\\b${norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay);
      if (matched) {
        hits.add(slug);
        break; // one keyword hit is enough to include the slug
      }
    }
  }
  return EXPERIENCE_CATEGORIES.filter((c) => hits.has(c));
}

// ─── Structured-attribute extractors for experiences-richer-profiles ──────────
//
// PURE — no LLM, no I/O. Each extractor returns a matched value + a provenance
// snippet (the exact text that yielded the value). Returns null/[] when no fact
// is found — never guesses. All accent-fold via stripNorwegianAccents().

/**
 * Extract the lowest advertised price per person in NOK.
 * Matches "fra 299 kr", "499 kr", "kr 299", "299,-", "NOK 399".
 */
export function extractPriceFrom(
  text: string | null | undefined
): { value: number | null; snippet: string | null } {
  if (!text) return { value: null, snippet: null };
  // Each pattern captures the numeric part in group 1.
  const PATTERNS = [
    /fra\s+(\d[\d\s]{0,5})\s*kr\b/gi,
    /(\d[\d\s]{0,5})\s*(?:,-|nok)\b/gi,
    /(\d[\d\s]{0,5})\s*kr\s*(?:\/\s*pers(?:on)?|pp\b)/gi,
    /\bkr\.?\s*(\d[\d\s]{0,5})\b/gi,
  ];
  let best: { value: number; snippet: string } | null = null;
  for (const pat of PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      const val = parseInt(m[1].replace(/\s/g, ""), 10);
      if (!isNaN(val) && val >= 10 && val <= 50000) {
        if (!best || val < best.value) best = { value: val, snippet: m[0].trim() };
      }
    }
  }
  return best ? { value: best.value, snippet: best.snippet } : { value: null, snippet: null };
}

/**
 * Extract experience duration in minutes.
 * Matches "2 timer", "90 min", "1,5 timer", "halvdag" (240 min), "heldag" (480 min).
 */
export function extractDurationMin(
  text: string | null | undefined
): { value: number | null; snippet: string | null } {
  if (!text) return { value: null, snippet: null };
  const HOUR_RE = /(\d+(?:[.,]\d+)?)\s*(?:time|timer|hours?)\b/gi;
  const MIN_RE = /(\d+)\s*min(?:utter?|utes?)?\b/gi;
  const HALF_DAY_RE = /\bhalv(?:e)?\s*dag\b/gi;
  const FULL_DAY_RE = /\bhel(?:e)?\s*dag\b/gi;
  let m: RegExpExecArray | null;
  if ((m = HOUR_RE.exec(text))) {
    const val = Math.round(parseFloat(m[1].replace(",", ".")) * 60);
    if (val > 0 && val <= 14400) return { value: val, snippet: m[0].trim() };
  }
  if ((m = MIN_RE.exec(text))) {
    const val = parseInt(m[1], 10);
    if (val > 0 && val <= 14400) return { value: val, snippet: m[0].trim() };
  }
  if ((m = HALF_DAY_RE.exec(text))) return { value: 240, snippet: m[0].trim() };
  if ((m = FULL_DAY_RE.exec(text))) return { value: 480, snippet: m[0].trim() };
  return { value: null, snippet: null };
}

const SEASON_LEXICON: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["summer", ["sommer", "sommeren", "juni", "juli", "august", "summer"]],
  ["winter", ["vinter", "vinteren", "desember", "januar", "februar", "winter"]],
  ["spring", ["var", "varen", "mars", "april", "mai", "spring"]],
  ["autumn", ["host", "hosten", "september", "oktober", "november", "autumn", "fall"]],
];

/**
 * Extract applicable seasons from visible text. Returns deduped season slugs +
 * one representative snippet per match. Accent-folds input before matching.
 */
export function extractSeasons(
  text: string | null | undefined
): { values: string[]; snippets: string[] } {
  if (!text) return { values: [], snippets: [] };
  const hay = stripNorwegianAccents(text.toLowerCase());
  const found: string[] = [];
  const snippets: string[] = [];
  for (const [season, keywords] of SEASON_LEXICON) {
    for (const kw of keywords) {
      if (hay.includes(kw)) { found.push(season); snippets.push(kw); break; }
    }
  }
  return { values: found, snippets };
}

/**
 * Detect indoor / outdoor suitability. Returns 'indoor', 'outdoor', 'both',
 * or null when undetectable from the text.
 */
export function extractIndoorOutdoor(
  text: string | null | undefined
): { value: "indoor" | "outdoor" | "both" | null; snippet: string | null } {
  if (!text) return { value: null, snippet: null };
  const hay = stripNorwegianAccents(text.toLowerCase());
  const INDOOR_KWS = ["innendors", "inne ", "innomhus", "indoor", "innenfor"];
  const OUTDOOR_KWS = ["utendors", "ute ", "utomhus", "outdoor", "utenfor", "friluft"];
  let indoorSnippet: string | null = null;
  let outdoorSnippet: string | null = null;
  for (const kw of INDOOR_KWS) { if (hay.includes(kw)) { indoorSnippet = kw.trim(); break; } }
  for (const kw of OUTDOOR_KWS) { if (hay.includes(kw)) { outdoorSnippet = kw.trim(); break; } }
  if (indoorSnippet && outdoorSnippet) return { value: "both", snippet: `${indoorSnippet} / ${outdoorSnippet}` };
  if (indoorSnippet) return { value: "indoor", snippet: indoorSnippet };
  if (outdoorSnippet) return { value: "outdoor", snippet: outdoorSnippet };
  return { value: null, snippet: null };
}

const ACTIVITY_TAG_LEXICON: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["guided_tour", ["guidet tur", "guided tour"]],
  ["kayaking", ["kajakk", "kayak"]],
  ["hiking", ["fottur", "fjelltur", "vandring", "hiking", "trekking"]],
  ["wildlife", ["hvalsafari", "dyreliv", "safari", "wildlife"]],
  ["fishing", ["fisketur", "havfiske", "fiske "]],
  ["skiing", ["skitur", "langrenn", "telemark"]],
  ["dogsledding", ["hundekjoring", "hundeslede"]],
  ["northern_lights", ["nordlys", "nordlystur", "aurora", "northern lights"]],
  ["rafting", ["rafting", "elvepadling"]],
  ["farm_visit", ["gardsbesok", "besoksgard", "gardsopplevelse"]],
  ["spa_wellness", ["spa", "wellness", "badstu", "isbad"]],
  ["food_tour", ["matkurs", "olsmaking", "food tour", "matvandring"]],
  ["cycling", ["sykkeltur", "terrengsykling", "cycling"]],
  ["climbing", ["klatring", "via ferrata", "climbing"]],
  ["water_sports", ["dykking", "snorkling", "stand up paddle"]],
];

/**
 * Extract activity tags from visible text. Returns up to 5 matched tag slugs +
 * one snippet per tag. PURE — accent-folds input before matching.
 */
export function extractActivityTags(
  text: string | null | undefined
): { values: string[]; snippets: string[] } {
  if (!text) return { values: [], snippets: [] };
  const hay = stripNorwegianAccents(text.toLowerCase());
  const found: string[] = [];
  const snippets: string[] = [];
  for (const [tag, keywords] of ACTIVITY_TAG_LEXICON) {
    if (found.length >= 5) break;
    for (const kw of keywords) {
      const norm = stripNorwegianAccents(kw);
      if (hay.includes(norm)) { found.push(tag as string); snippets.push(kw); break; }
    }
  }
  return { values: found, snippets };
}

/**
 * Extract a booking / ticket URL from raw HTML. Looks for <a href="…"> whose
 * anchor text or href contains booking keywords. Returns first match as an
 * absolute URL + a short excerpt of the anchor tag.
 */
export function extractBookingUrl(
  html: string | null | undefined,
  pageBaseUrl: string
): { value: string | null; snippet: string | null } {
  if (!html) return { value: null, snippet: null };
  const BOOKING_KEYWORDS = ["bestill", "book", "kjop", "ticket", "billet", "reserver", "billett"];
  const linkRe = /<a\s[^>]*href=["']([^"'#][^"']{0,200})["'][^>]*>([^<]{0,80})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1].trim();
    const anchorText = stripNorwegianAccents(m[2].toLowerCase());
    const hrefLower = stripNorwegianAccents(href.toLowerCase());
    if (BOOKING_KEYWORDS.some((kw) => anchorText.includes(kw) || hrefLower.includes(kw))) {
      try {
        const url = /^https?:\/\//i.test(href) ? href : new URL(href, pageBaseUrl).href;
        if (!/^https?:\/\//i.test(url)) continue; // reject javascript:, data:, etc.
        return { value: url, snippet: `<a href="${href}">${m[2].trim()}</a>` };
      } catch {
        /* malformed href — skip */
      }
    }
  }
  return { value: null, snippet: null };
}

/** SSRF guard: allow only http(s) to public hosts; block localhost, link-local,
 * private/CGNAT ranges and cloud-metadata (169.254.0.0/16). Domain names are allowed
 * (DNS-rebinding is out of scope for this admin-gated, dry-run-by-default endpoint). */
export function isSafeFetchUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  )
    return false;
  if (host.includes(":")) {
    // IPv6 literal: block loopback (::1), unique-local (fc00::/7), link-local (fe80::/10)
    if (host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return false;
    return true;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return false;
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local incl. cloud metadata
    if (a === 172 && b! >= 16 && b! <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b! >= 64 && b! <= 127) return false; // CGNAT
  }
  return true;
}

async function fetchHtml(url: string): Promise<string | null> {
  if (!isSafeFetchUrl(url)) return null;
  const fetchUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const resp = await fetch(fetchUrl, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Crawl the chosen candidate URL plus same-host /kontakt and /om-oss, and merge
 * all extracted emails/phones into one PageEvidence (title from the primary page).
 * This is the DEFAULT `crawl` dependency for enrichOneAgent.
 */
export async function buildPageEvidence(primaryUrl: string): Promise<PageEvidence | null> {
  const primaryHtml = await fetchHtml(primaryUrl);
  if (primaryHtml === null) return null;

  const emails = new Set<string>(extractEmails(primaryHtml));
  const phones = new Set<string>(extractPhones(primaryHtml));
  let combinedHtml = primaryHtml;
  const title = extractTitle(primaryHtml);

  // Try same-host /kontakt and /om-oss for additional contact details.
  try {
    const u = new URL(/^https?:\/\//i.test(primaryUrl) ? primaryUrl : `https://${primaryUrl}`);
    const base = `${u.protocol}//${u.host}`;
    for (const path of ["/kontakt", "/om-oss"]) {
      const subHtml = await fetchHtml(`${base}${path}`);
      if (subHtml) {
        for (const e of extractEmails(subHtml)) emails.add(e);
        for (const p of extractPhones(subHtml)) phones.add(p);
        combinedHtml += "\n" + subHtml;
      }
    }
  } catch {
    /* malformed URL — primary page evidence still stands */
  }

  return {
    url: primaryUrl,
    title,
    html: combinedHtml,
    emails: Array.from(emails),
    phones: Array.from(phones),
    // PR-A: visible text from the SAME already-fetched html (zero new fetches,
    // zero new Brave queries). Used downstream to extract CONTENT signals when
    // the page is confirmed as the producer's own.
    contentText: extractVisibleText(combinedHtml),
  };
}

/** Registrable host (last two labels) from a raw URL/host string. PURE. */
export function registrableHostFromUrl(raw: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
    const labels = host.split(".").filter(Boolean);
    if (labels.length < 2) return null;
    return labels.slice(-2).join(".");
  } catch {
    return null;
  }
}

// ─── enrichOneAgent — shared per-agent processing (orchestrator-pr-12) ───────
//
// The per-agent search→crawl→confirm→pick→tier decision, factored out of the
// inline POST /admin/search-enrich loop so the route AND the background sweep
// run IDENTICAL logic. All I/O is injected via `deps` so unit tests can stub
// search + crawl with zero network access.

export type EnrichTier = "write" | "queue" | "none";

export interface EnrichDeps {
  /** Web search — default: (q) => braveSearch(q, key, 5). */
  search: (query: string) => Promise<BraveResult[]>;
  /** Crawl a candidate URL into PageEvidence — default: buildPageEvidence. */
  crawl: (url: string) => Promise<PageEvidence | null>;
}

/** Input to enrichOneAgent: the stored producer plus identity + query fields. */
export type EnrichInput = StoredProducer & {
  agent_id: string;
  name: string;
  query: string;
};

/**
 * CONTENT signals extracted from a CONFIRMED producer homepage (PR-A). Present
 * on an EnrichRow ONLY when the chosen page was confirmed as the producer's own
 * (bestConfirm.confirmed) — so its presence is itself a provenance guarantee
 * that the content came from the producer's homepage, not google_places. The
 * downstream writer maps these to website_homepage-sourced about/products/
 * description/categories.
 */
export interface ContentSignals {
  /** Distinctive business-type tokens found on the page (besøkshage, ysteri…). */
  businessTypeTokens: string[];
  /** Normalized platform category hits (vegetables, meat…). */
  productMentions: string[];
  /** Deterministic extractive about summary (≤300 chars), or "" if none. */
  aboutSummary: string;
  /** The confirmed page URL the signals were extracted from (provenance). */
  sourceUrl: string;
  /** ISO timestamp the signals were extracted. */
  extractedAt: string;
}

export interface EnrichRow {
  agent_id: string;
  name: string;
  query: string;
  chosen_url: string | null;
  confirm: ConfirmResult;
  candidate_email: string | null;
  email_reason: string;
  tier: EnrichTier;
  /**
   * PR-A: homepage CONTENT signals — populated ONLY when bestConfirm.confirmed
   * (page is the producer's own). null on unconfirmed/no-candidate rows, so
   * producers with no usable homepage simply fall back to google_places (no
   * regression).
   */
  content_signals: ContentSignals | null;
}

/**
 * Process ONE agent: search the web, rank candidates, crawl the top ≤2 (via the
 * injected `crawl`), keep the strongest confirmation, pick the producer's own
 * email, and decide the tier. PURE w.r.t. the DB — it only reads `stored` and
 * the injected deps and returns a row. The caller persists / applies.
 *
 * Tier decision (identical to the original inline route):
 *   - write : strength === 'strong' AND an unambiguous producer email picked
 *   - queue : confirmed (medium) +/- email, OR a website found at medium strength
 *   - none  : everything else (no candidate, not confirmed, no usable email)
 *
 * A throw from `deps.search`/`deps.crawl` propagates to the caller, which is
 * responsible for the per-agent try/catch (one failure never aborts a batch).
 */
export async function enrichOneAgent(
  stored: EnrichInput,
  deps: EnrichDeps,
): Promise<EnrichRow> {
  const row: EnrichRow = {
    agent_id: stored.agent_id,
    name: stored.name,
    query: stored.query,
    chosen_url: null,
    confirm: { confirmed: false, strength: "none", signals: [] },
    candidate_email: null,
    email_reason: "no_candidate_url",
    tier: "none",
    content_signals: null,
  };

  const results = await deps.search(stored.query);
  const urls = rankCandidates(results, stored.name);
  const siteRoot = stored.siteRoot ?? null;

  let bestConfirm: ConfirmResult = row.confirm;
  let bestUrl: string | null = null;
  let bestEvidence: PageEvidence | null = null;

  // Crawl the top ≤2 candidates; keep the strongest confirmation.
  for (const url of urls) {
    const evidence = await deps.crawl(url);
    if (!evidence) continue;
    const conf = confirmProducerPage(stored, evidence);
    const rank = (s: string) => (s === "strong" ? 2 : s === "medium" ? 1 : 0);
    if (bestUrl === null || rank(conf.strength) > rank(bestConfirm.strength)) {
      bestConfirm = conf;
      bestUrl = url;
      bestEvidence = evidence;
      if (conf.strength === "strong") break; // can't do better
    }
  }

  row.chosen_url = bestUrl;
  row.confirm = bestConfirm;

  let pickedEmail: string | null = null;
  let emailReason = bestUrl ? "no_acceptable_email" : "no_candidate_url";

  if (bestConfirm.confirmed && bestEvidence) {
    const pick = pickProducerEmail(bestEvidence.emails, stored.name, siteRoot);
    pickedEmail = pick.email;
    emailReason = pick.reason;

    // PR-A: extract CONTENT signals from the CONFIRMED page only. Doing this
    // exclusively on a confirmed producer page is what guarantees provenance —
    // the writer can treat these as website_homepage-sourced (preferred over
    // google_places) precisely because we know the page is the producer's own.
    const contentText = bestEvidence.contentText ?? "";
    row.content_signals = {
      businessTypeTokens: extractBusinessTypeTokens(contentText),
      productMentions: extractProductMentions(contentText),
      aboutSummary: summarizeAbout(bestEvidence.html),
      sourceUrl: bestEvidence.url,
      extractedAt: new Date().toISOString(),
    };
  } else if (bestUrl) {
    emailReason = "page_not_confirmed";
  }
  row.candidate_email = pickedEmail;
  row.email_reason = emailReason;

  // ── tier decision (identical to the original inline route) ──
  let tier: EnrichTier = "none";
  if (bestConfirm.strength === "strong" && pickedEmail) {
    tier = "write";
  } else if (
    (bestConfirm.confirmed && pickedEmail) || // confirmed (medium) + email
    (bestConfirm.confirmed && !pickedEmail) || // confirmed but no usable email
    (bestUrl !== null && bestConfirm.strength === "medium") // website found, medium
  ) {
    tier = "queue";
  }
  row.tier = tier;

  return row;
}
