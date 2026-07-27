/**
 * Shared, CLASSIFIED page fetcher for every enrichment pipeline (rfb, dental,
 * experiences).
 *
 * Why this module exists (dev-request 2026-07-27-fetch-infrastruktur-diagnose,
 * P0-1). Three near-identical private helpers — `fetchHtml()` in
 * services/search-enrich.ts, `hcrFetchHtml()` in routes/admin-knowledge.ts and
 * `crFetchHtml()` in routes/opplevelser.ts — each ended in
 *
 *     if (!resp.ok) return null;
 *     ...
 *     } catch { return null; }
 *
 * which collapses every distinct failure mode into one indistinguishable
 * `null`. That single line is the root cause of a fleet-wide blind spot: every
 * enrichment run report for weeks has said some variant of "fetch_failed —
 * these may be parked or using anti-scraping measures", because the code
 * literally throws the reason away before anyone can read it.
 *
 * A 2026-07-26 measured probe over the 14 producer domains those reports had
 * named as failing found EIGHT different causes hiding behind that one `null`:
 *
 *   dns_not_found   3  hologardstun.no, norskquinoa.no, handbryggeri.no
 *   http_503        4  rekoringen.no, trondheimkooperativ.no,
 *                      smakerfraorkland.no, viltslakteriet.no
 *                      (text/plain, ~200 bytes — a hosting error page)
 *   http_401        1  hjortehagen.no (login wall)
 *   http_429        1  www.lofotenseaweed.com (rate limit, Retry-After 60)
 *   timeout         1  eventyrmost.no
 *   empty_body      1  vestre-bjolsund.no (HTTP 200, 152 bytes, DB error page)
 *   ok              2  hamre-hagen.no, finnskoghonning.no
 *
 * The last row is the expensive one: BOTH had been reported as hard 503
 * failures the day before and answered 200 on re-probe. With no retry and no
 * persistence classification, a momentary blip counts as a strike toward the
 * 3-strike/30-day parking rule — so the pipeline parks live producers and then
 * reports an empty candidate pool. Conversely `empty_body` (HTTP 200 with no
 * content) currently counts as SUCCESS, so those rows are re-fetched every
 * single run forever and never park.
 *
 * The same probe also DISPROVED the intuitive "our bot User-Agent is being
 * blocked" hypothesis: every URL was fetched twice, once with the current
 * `Lokal-*-Scraper/1.0` UA and once with a browser-like UA plus
 * `Accept-Language: nb-NO`, and the outcome was identical in all 14 cases.
 * That is recorded here deliberately so nobody spends another cycle on it —
 * and so nobody "fixes" the fetcher by disguising it as a browser, which we do
 * not want to do anyway.
 *
 * So this module's contract is: NEVER return a bare null. Every failure comes
 * back as a named `reason` plus a `persistence` class that tells the caller
 * whether parking the row is justified (`permanent`), whether it should be
 * retried later without a strike (`transient`), or whether a human needs to
 * look (`blocked`).
 *
 * All the classification helpers are PURE (no network/IO) so they are directly
 * unit-testable; `fetchPage()` is the only function here that touches the
 * network.
 */

// ── Tunables ────────────────────────────────────────────────────────────────

/** Default per-attempt timeout. Kept at the previous helpers' 10s. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Deliberately absent: any "the page is too short / too thin" threshold.
 *
 * Two candidate floors were tried against the measured data and both were
 * wrong. A byte floor (512 B) would have disqualified a legitimate 230-byte
 * page. A visible-text floor (30 chars) would have disqualified a real
 * producer page whose entire description lives in an `og:description` meta
 * attribute — visible body text "Velkomen til garden." is 20 characters, and
 * summarizeAbout() reads exactly that metadata.
 *
 * Deciding whether a page says ENOUGH is the extractors' job downstream
 * (meetsAboutQualityBar and friends). A fetcher that also editorialised about
 * content length would silently hide real pages from them — so this one only
 * answers "is there a page here at all", per isUnusableBody below.
 */

/**
 * Cap on how long we will honour a 429's `Retry-After` inside a single call.
 * lofotenseaweed.com asks for 60s, which is far too long to hold an enrichment
 * slot open — beyond this we give up for THIS run and report `http_429`
 * (transient, so no parking strike) and let the next run pick it up.
 */
export const MAX_RETRY_AFTER_WAIT_MS = 5_000;

// ── Result types ────────────────────────────────────────────────────────────

export type FetchFailureReason =
  | "ssrf_blocked"
  | "dns_not_found"
  | "timeout"
  | "tls_error"
  | "conn_refused"
  | "conn_reset"
  | "http_401"
  | "http_403"
  | "http_404"
  | "http_410"
  | "http_429"
  | "http_4xx"
  | "http_5xx"
  | "empty_body"
  | "not_html"
  | "unknown";

/**
 * How a caller should treat the failure.
 *
 * - `permanent`  the URL is genuinely dead/gone. Counting a parking strike is
 *                correct (dns_not_found, 404/410, ssrf_blocked).
 * - `transient`  the site exists but did not answer usefully right now
 *                (timeout, 5xx, 429, connection reset). MUST NOT count a
 *                parking strike — this is the class that was wrongly parking
 *                live producers.
 * - `blocked`    the site answered deliberately and negatively (401/403, or a
 *                200 with no content). Retrying is pointless — the same answer
 *                comes back — so callers DO count a parking strike here, same
 *                as `permanent`. It gets its own name rather than being folded
 *                into `permanent` because the remedy differs: a dead domain is
 *                gone for good, whereas a login-wall or an error stub may need
 *                a human or a different acquisition route. Only `transient`
 *                is strike-exempt.
 */
export type FetchPersistence = "permanent" | "transient" | "blocked";

export type FetchPageResult =
  | {
      ok: true;
      html: string;
      status: number;
      finalUrl: string;
      bytes: number;
      attempts: number;
      /** True when the response landed on a different origin than requested. */
      redirected: boolean;
    }
  | {
      ok: false;
      reason: FetchFailureReason;
      persistence: FetchPersistence;
      status: number | null;
      /** Short, log-safe detail (error code / status text). Never a stack. */
      detail: string;
      attempts: number;
    };

// ── Pure classifiers ────────────────────────────────────────────────────────

/** Map an HTTP status to a failure reason. PURE. Returns null for 2xx. */
export function classifyHttpStatus(status: number): FetchFailureReason | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  if (status === 404) return "http_404";
  if (status === 410) return "http_410";
  if (status === 429) return "http_429";
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  // A 3xx should never reach here (redirect: "follow" resolves them), but if one
  // escapes — a redirect loop hitting the cap, a 304 from a conditional request —
  // report it as `unknown` rather than mislabelling it `http_4xx`. In a module
  // whose whole premise is that the reported reason must be truthful, a wrong
  // name is worse than an unspecific one.
  return "unknown";
}

/**
 * Map a thrown fetch error to a failure reason. PURE.
 *
 * Node surfaces the useful code on `err.cause.code` for undici network errors,
 * but `AbortSignal.timeout()` rejects with a DOMException whose `name` is
 * "TimeoutError" and whose numeric `code` is 23 (ABORT_ERR) — the measured
 * probe hit exactly that shape on eventyrmost.no, so it is matched explicitly
 * here instead of falling through to `unknown`.
 */
export function classifyFetchError(err: unknown): FetchFailureReason {
  const e = err as { name?: string; code?: unknown; message?: string; cause?: { code?: string } };
  const name = String(e?.name ?? "");
  const causeCode = String(e?.cause?.code ?? "");
  const message = String(e?.message ?? "");
  const probe = `${name} ${causeCode} ${message}`;

  if (name === "TimeoutError" || name === "AbortError" || e?.code === 23) return "timeout";
  if (/ETIMEDOUT|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(probe)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN/i.test(probe)) return "dns_not_found";
  if (/CERT|SSL|TLS|ERR_TLS|DEPTH_ZERO|SELF_SIGNED|ALTNAME/i.test(probe)) return "tls_error";
  if (/ECONNREFUSED/i.test(probe)) return "conn_refused";
  if (/ECONNRESET|UND_ERR_SOCKET|socket hang up/i.test(probe)) return "conn_reset";
  return "unknown";
}

/** Whether a failure justifies a parking strike. PURE. */
export function persistenceOf(reason: FetchFailureReason): FetchPersistence {
  switch (reason) {
    case "dns_not_found":
    case "http_404":
    case "http_410":
    case "ssrf_blocked":
      return "permanent";
    case "timeout":
    case "http_429":
    case "http_5xx":
    case "conn_reset":
    case "conn_refused":
    case "tls_error":
      // tls_error and conn_refused sit here deliberately: an expired
      // certificate or a briefly-down port is routinely fixed by the site
      // owner within days, and mis-parking a real producer for 30 days costs
      // us far more than one wasted re-fetch.
      return "transient";
    case "http_401":
    case "http_403":
    case "empty_body":
    case "not_html":
    case "http_4xx":
    case "unknown":
      return "blocked";
  }
}

/** True if a failure should be retried once within the same call. PURE. */
export function isRetryable(reason: FetchFailureReason): boolean {
  return reason === "timeout" || reason === "http_5xx" || reason === "conn_reset";
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms. Returns
 * null when absent/unparseable. PURE apart from the `now` argument, which is
 * injected so the HTTP-date branch is testable.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delta = date - now;
  return delta > 0 ? delta : 0;
}

/** Visible text of an HTML document: markup, scripts and styles removed. PURE. */
export function visibleTextOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a 200 response carries no usable page. PURE.
 *
 * The discriminator is MARKUP ABSENCE, not body size — a distinction the
 * 2026-07-26 measurement forced. The obvious "small body means error stub"
 * heuristic does not survive contact with the data:
 *
 *   vestre-bjolsund.no  200  152 B   152 visible chars   ← DB error stub
 *   rekoringen.no       503  190 B   190 visible chars   ← hosting stub
 *   hamre-hagen.no      200  12341 B 305 visible chars   ← a REAL producer site
 *
 * A visible-text threshold that catches the 152-char stub would also have to
 * sit under the real site's 305 chars — far too narrow a window to trust. But
 * look at the byte/char columns: for every stub they are IDENTICAL, because
 * those responses are plain-text error messages mislabelled `text/html` with
 * no HTML element in them at all. Real pages always carry markup. So "the body
 * contains no HTML tag" separates the two cleanly, with no size guessing and
 * no risk of hiding a small-but-real page from the extractors.
 *
 * The second shape is a non-HTML content type (a PDF or image sitting at the
 * stored "homepage" URL — the same class of supply-hygiene problem).
 */
export function isUnusableBody(
  html: string,
  contentType: string | null | undefined,
): FetchFailureReason | null {
  const ct = (contentType ?? "").toLowerCase().split(";")[0]!.trim();
  const hasMarkup = /<[a-z!\/][^>]*>/i.test(html);

  // Only types we positively know are NOT markup are rejected on the header
  // alone. An unrecognised or missing content-type falls through to the markup
  // sniff instead: small Norwegian hosts do serve real HTML as
  // `application/octet-stream` or `application/x-httpd-php`, and the previous
  // allowlist-only rule turned every such page into `not_html` → a parking
  // strike, where the old code fetched and extracted it fine.
  if (ct && /^(image|video|audio|font)\//.test(ct)) return "not_html";
  if (ct && /^application\/(pdf|zip|gzip|octet-stream|json|xml)$/.test(ct) && !hasMarkup) {
    return "not_html";
  }

  if (!hasMarkup) return "empty_body";
  return null;
}

// ── SSRF guard + charset decoding ───────────────────────────────────────────
// Moved here from services/search-enrich.ts so this module has no import edge
// back into it (search-enrich re-exports them unchanged for existing callers).
// A fetch helper that had to import from search-enrich, while search-enrich
// imports the fetch helper, is exactly the circular-import shape that has
// already bitten this repo once (lokal#218).

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

/**
 * Detect a fetched HTML page's declared character encoding from (in order of
 * precedence, matching the HTML5 "determining the character encoding"
 * algorithm's priority): the HTTP `Content-Type` charset parameter, then a
 * `<meta charset=...>` / `<meta http-equiv="Content-Type" content="...
 * charset=...">` tag sniffed from the first 1024 bytes. Falls back to
 * "utf-8" when neither declares one (the HTML5 spec falls back to
 * windows-1252 for legacy/unlabelled pages, but defaulting to utf-8 here is
 * the safer choice for THIS pipeline: the overwhelming majority of scraped
 * producer sites are UTF-8, and wrongly assuming windows-1252 would corrupt
 * far more of them than it would fix). PURE — no network/IO, byte-array in.
 *
 * Root cause (2026-07-25, dev-request 2026-07-21-opplevagent-norske-tegn-
 * encoding): fetchHtml() previously called `resp.text()`, which per the
 * WHATWG Fetch spec ALWAYS UTF-8-decodes the response body regardless of
 * what charset the server actually declares. Small/older gårdssalg producer
 * sites still commonly serve `Content-Type: text/html; charset=iso-8859-1`
 * (or an equivalent `<meta>` tag, windows-1252 in practice) — decoding those
 * bytes as UTF-8 corrupts every æ/ø/å into mojibake or drops it entirely
 * (invalid byte sequences become U+FFFD), and that corrupted text was then
 * extracted verbatim (extractVisibleText/extractTitle, no LLM step) straight
 * into the producer's stored profile content. This function's job is to
 * decode with the PAGE's actual encoding instead of assuming UTF-8.
 */
export function detectHtmlCharset(
  bytes: Uint8Array,
  contentTypeHeader: string | null | undefined,
): string {
  const headerMatch = contentTypeHeader?.match(/charset\s*=\s*["']?([\w-]+)/i);
  if (headerMatch) return headerMatch[1].toLowerCase();

  // Sniff only the first 1024 bytes (where a <meta charset> tag must appear
  // per HTML5 spec) as Latin-1 — a lossless 1:1 byte→codepoint mapping, so
  // the ASCII-range markup bytes we're matching against (`<meta`, `charset=`,
  // quotes) decode identically regardless of the page's real encoding.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const metaCharset = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
  if (metaCharset) return metaCharset[1].toLowerCase();

  return "utf-8";
}

/**
 * Decode a raw HTML response body with its actual declared encoding (see
 * detectHtmlCharset). Unknown/unsupported charset labels (typos, obscure
 * legacy names Node's TextDecoder doesn't ship) fall back to utf-8 rather
 * than throwing — a best-effort decode beats dropping the page entirely.
 * PURE — no network/IO.
 */
export function decodeHtmlBytes(
  bytes: Uint8Array,
  contentTypeHeader: string | null | undefined,
): string {
  const charset = detectHtmlCharset(bytes, contentTypeHeader);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ── Link-driven sub-page discovery ──────────────────────────────────────────

/**
 * Same-host links worth following for contact/about/product content, ranked.
 * PURE — parses the already-fetched HTML, issues no requests.
 *
 * Replaces the blind fixed-path guessing (`/om-oss`, `/about`, `/produkter`,
 * `/kontakt`) that all three helpers did. Measured on three live, content-rich
 * producer sites (berg-gaard.no, finnskoghonning.no, hamre-hagen.no) on
 * 2026-07-26, those four guesses returned 404 twelve times out of twelve —
 * a 100% miss rate costing 3-4 wasted fetches per agent, which on the
 * experiences side is what pushes a run into its 90s time cap after only
 * three chunks.
 *
 * They miss because the guesses do not match how these sites are actually
 * built: berg-gaard.no is a single-page site whose contact block is the
 * in-page anchor `/#kontakt`, and finnskoghonning.no exposes no crawlable
 * internal links at all. Following real links instead both removes the waste
 * AND finds the Norwegian paths the fixed list never covered (`/om`,
 * `/om-garden`, `/kontakt-oss`, `/vare-produkter`, …).
 *
 * Pure in-page anchors (`/#kontakt`, `#top`) are deliberately dropped: their
 * content is already in the primary HTML the caller holds, so fetching them
 * would re-download the same page.
 */
export function discoverContentLinks(html: string, baseUrl: string, max = 3): string[] {
  let base: URL;
  try {
    base = new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`);
  } catch {
    return [];
  }

  // Higher score = fetch first. Contact pages outrank about pages because a
  // verified email/phone unblocks outreach, which is the pipeline's north-star.
  const PATTERNS: ReadonlyArray<{ re: RegExp; score: number }> = [
    { re: /kontakt|contact/i, score: 3 },
    { re: /om-?oss|om-?garden|om-?gården|about|historie/i, score: 2 },
    { re: /produkt|product|vare|nettbutikk|butikk|meny/i, score: 1 },
  ];

  const scored = new Map<string, number>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const rawHref = m[1]!;
    const linkText = m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    // Drop pure in-page anchors before resolving — "#kontakt" and "/#kontakt"
    // both resolve to the primary page we already have in memory.
    if (rawHref.startsWith("#")) continue;

    let abs: URL;
    try {
      abs = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    if (abs.host !== base.host) continue; // same-host only
    abs.hash = "";
    if (abs.pathname === base.pathname && abs.search === base.search) continue; // same page

    const haystack = `${abs.pathname} ${linkText}`;
    let best = 0;
    for (const { re, score } of PATTERNS) {
      if (re.test(haystack)) best = Math.max(best, score);
    }
    if (best === 0) continue;

    const key = abs.toString();
    scored.set(key, Math.max(scored.get(key) ?? 0, best));
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, max))
    .map(([url]) => url);
}

// ── The fetcher ─────────────────────────────────────────────────────────────

export type FetchPageOptions = {
  userAgent: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injected for tests; defaults to the global fetch. Passing a stub here is
   * strictly preferable to swapping `globalThis.fetch`: this repo's test suite
   * runs many async blocks interleaved, so a global swap both serves other
   * blocks' requests and lets their requests inflate this one's call counts
   * (dev-request 2026-07-25-testsuite-ikke-deterministisk-delte-globaler is
   * the standing bug for exactly that class of cross-test bleed).
   */
  fetchImpl?: typeof fetch;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch one URL and return a CLASSIFIED result. Never throws, never returns a
 * bare null.
 *
 * Retry policy: at most ONE extra attempt, and only for `isRetryable()`
 * reasons (timeout / 5xx / connection reset). This is what stops a momentary
 * blip from counting as a parking strike — the measured probe found two of
 * fourteen "dead" domains answering 200 on re-probe the next day. A 429 is
 * retried only when its `Retry-After` fits inside MAX_RETRY_AFTER_WAIT_MS,
 * so a site asking us to wait a minute is left for the next run instead of
 * holding an enrichment slot open.
 */
export async function fetchPage(url: string, opts: FetchPageOptions): Promise<FetchPageResult> {
  if (!isSafeFetchUrl(url)) {
    return {
      ok: false,
      reason: "ssrf_blocked",
      persistence: "permanent",
      status: null,
      detail: "url rejected by SSRF guard",
      attempts: 0,
    };
  }

  const fetchUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  let attempts = 0;
  let last: Extract<FetchPageResult, { ok: false }> | null = null;

  // Two passes max: the initial attempt plus one retry for retryable reasons.
  for (let pass = 0; pass < 2; pass++) {
    attempts++;
    let resp: Response;
    try {
      resp = await doFetch(fetchUrl, {
        redirect: "follow",
        headers: { "User-Agent": opts.userAgent, Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = classifyFetchError(err);
      last = {
        ok: false,
        reason,
        persistence: persistenceOf(reason),
        status: null,
        detail: String((err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.name ?? "error").slice(0, 60),
        attempts,
      };
      if (pass === 0 && isRetryable(reason)) continue;
      return last;
    }

    const statusReason = classifyHttpStatus(resp.status);
    if (statusReason) {
      last = {
        ok: false,
        reason: statusReason,
        persistence: persistenceOf(statusReason),
        status: resp.status,
        detail: resp.statusText?.slice(0, 60) || `HTTP ${resp.status}`,
        attempts,
      };
      if (pass === 0 && statusReason === "http_429") {
        const waitMs = parseRetryAfterMs(resp.headers.get("retry-after"), now());
        if (waitMs !== null && waitMs <= MAX_RETRY_AFTER_WAIT_MS) {
          await sleep(waitMs);
          continue;
        }
        return last;
      }
      if (pass === 0 && isRetryable(statusReason)) continue;
      return last;
    }

    const buf = await resp.arrayBuffer().catch(() => null);
    if (buf === null) {
      const reason: FetchFailureReason = "conn_reset";
      last = {
        ok: false,
        reason,
        persistence: persistenceOf(reason),
        status: resp.status,
        detail: "body read failed",
        attempts,
      };
      if (pass === 0) continue;
      return last;
    }

    const bytes = new Uint8Array(buf);
    const contentType = resp.headers.get("content-type");
    const html = decodeHtmlBytes(bytes, contentType);
    const unusable = isUnusableBody(html, contentType);
    if (unusable) {
      // Not retried: an error stub or a non-HTML document answers identically
      // on a second try, and `blocked` persistence already tells the caller
      // not to treat it as a dead-site strike.
      return {
        ok: false,
        reason: unusable,
        persistence: persistenceOf(unusable),
        status: resp.status,
        detail: `${bytes.byteLength}B ${(contentType ?? "?").split(";")[0]}`.slice(0, 60),
        attempts,
      };
    }

    let finalUrl = resp.url || fetchUrl;
    let redirected = false;
    try {
      redirected = new URL(finalUrl).host !== new URL(fetchUrl).host;
    } catch {
      /* keep redirected=false when either URL is unparseable */
    }

    return {
      ok: true,
      html,
      status: resp.status,
      finalUrl,
      bytes: bytes.byteLength,
      attempts,
      redirected,
    };
  }

  /* istanbul ignore next — the loop always returns or sets `last` */
  return (
    last ?? {
      ok: false,
      reason: "unknown",
      persistence: "blocked",
      status: null,
      detail: "no attempt completed",
      attempts,
    }
  );
}

