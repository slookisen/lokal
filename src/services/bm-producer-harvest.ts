// ─── bm-producer-harvest.ts (dev-request 2026-08-14-bm-fullhoest-katalogbred, slice 2) ──
//
// Bondens Marked (bondensmarked.no) publishes ~345 producer profile pages
// under /produsenter/<slug>. This module discovers those slugs from the
// public sitemap, fetches + parses individual producer pages, and fuzzy-
// matches the parsed record against our own `agents` catalog (role =
// 'producer', is_active = 1).
//
// READ-ONLY / DRY-RUN ONLY. Nothing in this file performs a database write
// of any kind — no INSERT/UPDATE/DELETE, no `.run(`. The route that
// consumes this module (routes/admin-bm-producer-harvest.ts) is likewise
// read-only for this slice; write-through-existing-levers logic is an
// explicitly separate future slice (see dev-request, slice 3).
//
// Dependency-light by design (mirrors bondensmarked-source.ts's stated
// philosophy): no new npm packages, just built-in fetch/regex/JSON.parse.
//
// Slice 1 (lokal#592) added "directory_listing" to TIER_B in
// cross-source-validator.ts — untouched here, different file.

import { diceCoefficient } from "./debio-cross-check";
import { RFB_WD_DIRECTORY_HOSTS } from "../routes/admin-rfb-website-discovery";
import { getDb } from "../database/init";

const BM_BASE_URL = "https://bondensmarked.no";
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)";

// ─── Slug validation ──────────────────────────────────────────────────────
// Mirrors bondensmarked-source.ts's LOKALLAG_SLUG_RE style: validate before
// any slug is interpolated into a URL.
const BM_PRODUCER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function isValidBmProducerSlug(slug: unknown): slug is string {
  return typeof slug === "string" && BM_PRODUCER_SLUG_RE.test(slug);
}

// ─── Public shape ─────────────────────────────────────────────────────────

export interface BmProducerRecord {
  slug: string;
  name: string;
  website: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  sourceUrl: string;
  /**
   * true when a mailto: WAS found on the page but was excluded from `email`
   * solely because it belongs to bondensmarked.no's own domain (the "aldri
   * @bondensmarked.no" rule, applied defensively here on the read path).
   * Diagnostic-only — lets the admin route report
   * bm_domain_email_excluded_count from a single fetch+parse instead of a
   * second network round-trip or hidden module state. Computed in the same
   * place the exclusion itself happens (parseBmProducerPage), so the two
   * can never drift apart.
   */
  bmDomainEmailExcluded: boolean;
}

// ─── Sitemap → slug list ──────────────────────────────────────────────────

export async function fetchBmProducerSlugs(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const url = `${BM_BASE_URL}/sitemap.xml`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/xml,text/xml,*/*",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      `[bm-producer-harvest] sitemap fetch threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!res.ok) {
    console.warn(`[bm-producer-harvest] sitemap fetch failed: HTTP ${res.status}`);
    return [];
  }
  const xml = await res.text();
  return extractProducerSlugsFromSitemap(xml);
}

/**
 * Pure sitemap parser. Only admits <loc> values shaped exactly
 * https://bondensmarked.no/produsenter/<slug> — i.e. exactly two non-empty
 * path segments, the first literally "produsenter". That single shape rule
 * is what excludes both the bare index (/produsenter, 1 segment) and the
 * static "become a producer" page (/bli-produsent, 1 segment, different
 * first segment) without any special-casing of their names.
 */
function extractProducerSlugsFromSitemap(xml: string): string[] {
  const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  const seen = new Set<string>();
  const slugs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) !== null) {
    const raw = m[1].trim();
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "bondensmarked.no") continue;
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[0] !== "produsenter") continue;
    const slug = segments[1];
    if (!isValidBmProducerSlug(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

// ─── Producer page → record ────────────────────────────────────────────────

function extractLdJsonBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

/** Selects the LocalBusiness ld+json block among possibly several on the page. */
function findLocalBusinessJsonLd(html: string): any | null {
  for (const block of extractLdJsonBlocks(html)) {
    try {
      const parsed = JSON.parse(block.trim());
      if (parsed && typeof parsed === "object" && parsed["@type"] === "LocalBusiness") {
        return parsed;
      }
    } catch {
      continue; // malformed JSON in this particular block — try the next one
    }
  }
  return null;
}

function extractFirstMailto(html: string): string | null {
  const m = /href\s*=\s*["']mailto:([^"'?]+)/i.exec(html);
  return m ? m[1].trim() : null;
}

function extractFirstTel(html: string): string | null {
  const m = /href\s*=\s*["']tel:([^"']+)/i.exec(html);
  return m ? m[1].trim() : null;
}

function hostOf(raw: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Suffix-walk against RFB_WD_DIRECTORY_HOSTS (routes/admin-rfb-website-
 * discovery.ts) — the SAME curated directory-host set, imported rather than
 * re-declared, so this module can never silently drift from it. Mirrors the
 * suffix-walk shape of rfbWebsiteHostExclusionReason in that file.
 */
function isDirectoryHost(host: string): boolean {
  const labels = host.split(".").filter(Boolean);
  for (let i = 0; i + 2 <= labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    if (RFB_WD_DIRECTORY_HOSTS.has(suffix)) return true;
  }
  return false;
}

function isBmDomainEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase().replace(/\.$/, "");
  return domain === "bondensmarked.no" || domain.endsWith(".bondensmarked.no");
}

function slugFromSourceUrl(sourceUrl: string): string {
  try {
    const segments = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    return segments.length ? segments[segments.length - 1] : "";
  } catch {
    return "";
  }
}

/**
 * Pure parser — no fetch. Returns null (after a console.warn) whenever the
 * page has no usable LocalBusiness block, never throws.
 */
export function parseBmProducerPage(html: string, sourceUrl: string): BmProducerRecord | null {
  const ld = findLocalBusinessJsonLd(html);
  if (!ld) {
    console.warn(`[bm-producer-harvest] no LocalBusiness ld+json block found: ${sourceUrl}`);
    return null;
  }

  const name = typeof ld.name === "string" ? ld.name.trim() : "";
  if (!name) {
    console.warn(`[bm-producer-harvest] LocalBusiness block has no usable name: ${sourceUrl}`);
    return null;
  }

  let website: string | null = null;
  if (typeof ld.url === "string" && ld.url.trim()) {
    const rawUrl = ld.url.trim();
    const host = hostOf(rawUrl);
    // Never surface a directory host (including bondensmarked.no itself) as
    // the producer's own website. Fail CLOSED: a URL whose host we cannot
    // even parse/verify is treated as excluded, not as safe — otherwise an
    // unparseable directory-host URL (e.g. a stray leading space defeating
    // hostOf's scheme regex) would leak straight through unvalidated.
    website = host === null ? null : isDirectoryHost(host) ? null : rawUrl;
  }

  const city =
    ld.address &&
    typeof ld.address === "object" &&
    typeof ld.address.addressLocality === "string" &&
    ld.address.addressLocality.trim()
      ? ld.address.addressLocality.trim()
      : null;

  const mailto = extractFirstMailto(html);
  const bmDomainEmailExcluded = !!mailto && isBmDomainEmail(mailto);
  // Never surface BM's own address as the producer's contact.
  const email = mailto && !bmDomainEmailExcluded ? mailto : null;

  const phone = extractFirstTel(html);

  return {
    slug: slugFromSourceUrl(sourceUrl),
    name,
    website,
    city,
    email,
    phone,
    sourceUrl,
    bmDomainEmailExcluded,
  };
}

export async function fetchBmProducerRecord(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BmProducerRecord | null> {
  if (!isValidBmProducerSlug(slug)) {
    console.warn(`[bm-producer-harvest] invalid producer slug rejected: ${JSON.stringify(slug)}`);
    return null;
  }
  const sourceUrl = `${BM_BASE_URL}/produsenter/${slug}`;
  let res: Response;
  try {
    res = await fetchImpl(sourceUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      `[bm-producer-harvest] fetch threw for ${sourceUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!res.ok) {
    console.warn(`[bm-producer-harvest] HTTP ${res.status} for ${sourceUrl}`);
    return null;
  }
  const html = await res.text();
  return parseBmProducerPage(html, sourceUrl);
}

// ─── Catalog matching ───────────────────────────────────────────────────────
//
// Closest prior art is debio-cross-check.ts's fuzzyMatchAgent() (loop over
// producer agents, score by diceCoefficient, keep best above a threshold).
// Not reused directly — this matcher additionally requires a city/locality
// anchor, which that helper doesn't have — but the shape mirrors it.

// Mirrors debio-cross-check.ts's FUZZY_NAME_THRESHOLD value (0.85), declared
// locally rather than imported so this module stays self-contained.
const BM_MATCH_NAME_THRESHOLD = 0.85;

export interface BmMatchResult {
  agentId: string;
  agentName: string;
  nameScore: number;
  cityMatched: boolean;
}

/** lowercase + strip diacritics + trim, for a loose city/locality comparison. */
function normaliseCityForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Anchor agreement: exact match after normalising only. Either side
 * null/empty → FAILS (an anchor we cannot verify is no anchor). Deliberately
 * NOT a substring/fuzzy match — short real Norwegian place names (e.g. "Os",
 * "Nes") are substrings of unrelated municipalities ("Oslo", "Osen",
 * "Nesodden"), so a "one contains the other" rule would let name-similarity
 * alone rubber-stamp a match, defeating the entire purpose of the anchor.
 */
function cityAnchorAgrees(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const na = normaliseCityForMatch(a);
  const nb = normaliseCityForMatch(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * READ-ONLY. Queries `agents` (role='producer' AND is_active=1), scores
 * every candidate by name similarity, and returns the single best match
 * only if it clears BOTH: name score >= BM_MATCH_NAME_THRESHOLD AND a
 * city/locality anchor agreement with record.city. Neither condition alone
 * is sufficient. No write of any kind.
 */
export function matchBmProducerToCatalog(
  db: ReturnType<typeof getDb>,
  record: BmProducerRecord,
): BmMatchResult | null {
  const agents = db
    .prepare(`SELECT id, name, city FROM agents WHERE role = 'producer' AND is_active = 1`)
    .all() as Array<{ id: string; name: string; city: string | null }>;

  let best: { id: string; name: string; city: string | null; score: number } | null = null;
  for (const a of agents) {
    if (!a.name) continue;
    const score = diceCoefficient(record.name, a.name);
    if (!best || score > best.score) best = { ...a, score };
  }

  if (!best || best.score < BM_MATCH_NAME_THRESHOLD) return null;
  if (!cityAnchorAgrees(record.city, best.city)) return null;

  return {
    agentId: best.id,
    agentName: best.name,
    nameScore: best.score,
    cityMatched: true,
  };
}
