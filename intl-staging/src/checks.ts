// Deterministic gate for a submitted draft — runs before any LLM judge sees it.
//
// Every rule here traces to the phase-1 legal drafts (A2A strategic-decisions/
// se-dk-fase1/): the field whitelist (LIA SE §5), "KI kan bare skrive påstander
// som finnes i en kilde" (LIA §6.5, DPIA T4), the personnummer block (T7), source
// discipline (T8: no logged-in sources, no Facebook/REKO groups, private
// catalogues only for spot checks), and two-source confirmation for a visiting
// address (T1, LIA §5).
import { findPersonnummer } from "./pii";
import { SE_CERTIFICATIONS, SE_PRODUCT_CATEGORIES, SE_SALES_CHANNELS } from "./vocab";

export interface Source {
  url: string;
  quote?: string;
}
export interface FieldValue {
  value: unknown;
  sources: Source[];
}
export interface ExcerptIn {
  url: string;
  text: string;
  fetched_at?: string;
}
export interface UnitInfo {
  org_nr: string;
  postal_town: string | null;
  street: string | null;
}
export interface CheckResult {
  ok: boolean;
  errors: string[];
}

export const REGISTER_SOURCE = "register:se";

export const ALLOWED_FIELDS = [
  "display_name",
  "website",
  "business_email",
  "business_phone",
  "visit_address",
  "postal_town",
  "municipality",
  "opening_hours",
  "season",
  "product_categories",
  "sales_channels",
  "certifications",
  "org_nr",
] as const;

// Hosts that may never be a field source: social media and closed groups (T8),
// people-search and credit sites (personal data about owners), map/review
// aggregators and commercial directories (private catalogues — spot checks
// only, LIA §1.2 / URL 49 §). The builder may still use them to FIND a website.
const SOURCE_HOST_DENYLIST = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "google.com",
  "google.se",
  "tripadvisor.com",
  "tripadvisor.se",
  "hitta.se",
  "eniro.se",
  "allabolag.se",
  "ratsit.se",
  "merinfo.se",
  "upplysning.se",
  "proff.se",
  "bolagsfakta.se",
  "foretagsfakta.se",
  "birthday.se",
  "mrkoll.se",
];

// Hosts that can never be the producer's OWN website: link shorteners, map/
// listing pages and directories (review 2026-10-13: a directory page passed as
// "website" made the own-site rule meaningless).
const NOT_AN_OWN_SITE = [
  ...SOURCE_HOST_DENYLIST,
  "youtube.com",
  "business.site",
  "g.page",
  "goo.gl",
  "maps.app.goo.gl",
  "yelp.com",
  "yelp.se",
  "gulasidorna.se",
  "118100.se",
  "bizzdo.se",
  "kompass.com",
  "reko-ringar.se",
  "rekoringar.se",
  "linktr.ee",
];

// Sources other than the producer's own site that a field may use.
const OPENSTREETMAP = ["openstreetmap.org"];

export const MIN_QUOTE_CHARS = 8;

const FREE_TEXT_FIELDS = ["display_name", "opening_hours", "season", "municipality", "postal_town"];

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The producer's own site host, or null when the website field is missing or not a real host. */
export function ownSiteHost(fields: Record<string, FieldValue> | undefined): string | null {
  const v = fields?.website?.value;
  const h = typeof v === "string" ? hostOf(v) : null;
  return h && h.includes(".") ? h : null;
}

/** Hosts a page excerpt may come from: the own site plus the named exceptions. */
export function excerptHostAllowed(host: string, websiteHost: string | null): boolean {
  const allowed = [...(websiteHost ? [websiteHost] : []), "openstreetmap.org", ...Object.values(SE_CERTIFICATIONS).flat()];
  return allowed.some((d) => host === d || host.endsWith(`.${d}`));
}

export function normUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function hostIn(host: string, list: string[]): boolean {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}
function isDenylisted(host: string): boolean {
  return hostIn(host, SOURCE_HOST_DENYLIST);
}

function phoneDigits(s: string): string {
  let d = s.replace(/\D/g, "");
  if (d.startsWith("0046")) d = `0${d.slice(4)}`;
  else if (d.startsWith("46") && s.trim().startsWith("+")) d = `0${d.slice(2)}`;
  return d;
}

/**
 * Digits of a quote with every international Swedish prefix inside it turned
 * into the national 0, so "Ring +46 (0)31-123 45 67" carries 0311234567. The
 * value side only sees a lone number, but a quote is running text where the
 * +46 sits mid-sentence (run 2026-10-14: 4 of 13 refusals were this).
 */
export function quotePhoneDigits(s: string): string {
  return s.replace(/(?:\+|\b00)\s*46[\s-]*(?:\(\s*0\s*\)[\s-]*)?/g, "0").replace(/\D/g, "");
}

/**
 * Replaces personnummer-shaped numbers in raw page text before it is stored.
 * `keepDigits` exempts the declared business phone: about one Swedish phone
 * number in a hundred has the date+Luhn shape, and redacting it would break the
 * phone field's own quote. The judge still checks that the number is published
 * for the business.
 */
export function redactExcerpt(text: string, keepDigits: string[] = []): { text: string; redacted: number } {
  let redacted = 0;
  let out = text;
  for (const hit of findPersonnummer(text)) {
    if (isDeclaredPhoneHit(hit, keepDigits)) continue;
    out = out.split(hit).join("[borttaget]");
    redacted++;
  }
  return { text: out, redacted };
}

/** A Swedish phone number after +46 → 0: a leading 0 and 8–10 digits in all. */
export const SWEDISH_PHONE_RE = /^0\d{7,9}$/;

export function declaredPhoneDigits(fields: Record<string, FieldValue> | undefined): string[] {
  const v = fields?.business_phone?.value;
  if (typeof v !== "string") return [];
  const d = phoneDigits(v);
  return SWEDISH_PHONE_RE.test(d) ? [d] : [];
}

/**
 * Whether a personnummer-shaped hit may stay because it IS the declared
 * business phone. Only 10-digit hits that start with 0 qualify, and never one
 * written the personnummer way (6 digits, any separator, 4 digits) — phone
 * numbers are not grouped like that (review 2026-10-13, rounds 2 and 3). An
 * unseparated 10-digit number starting with 0 stays ambiguous (born 2000–09);
 * the judge's personal-data check covers that residual.
 */
export function isDeclaredPhoneHit(hit: string, keepDigits: string[]): boolean {
  const d = hit.replace(/\D/g, "");
  if (d.length !== 10 || !d.startsWith("0")) return false;
  if (/^\d{6}[-+\u2010-\u2015\u2212 \u00a0\u202f.]\d{4}$/.test(hit)) return false;
  return keepDigits.includes(d);
}

export function checkDraft(fields: Record<string, FieldValue>, excerpts: ExcerptIn[], unit: UnitInfo): CheckResult {
  const errors: string[] = [];
  const excerptByUrl = new Map<string, string>();
  for (const e of excerpts) {
    const key = normUrl(e.url);
    excerptByUrl.set(key, `${excerptByUrl.get(key) || ""} ${normText(e.text)}`);
  }

  for (const key of Object.keys(fields)) {
    if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) errors.push(`field_not_allowed:${key}`);
  }
  if (!fields.display_name) errors.push("missing:display_name");
  if (!fields.product_categories && !fields.sales_channels) errors.push("missing:product_categories_or_sales_channels");
  // Every profile rests on the producer's own website (LIA SE §5/§6.7, DPIA T8):
  // without one there is nothing that may be quoted.
  if (!fields.website) errors.push("missing:website");

  const websiteHost = ownSiteHost(fields);
  // Which non-register hosts a field may quote from: the own site, plus a few
  // named exceptions. Anything else (directories, catalogues) is refused.
  const allowedHosts = (key: string): string[] => {
    const own = websiteHost ? [websiteHost] : [];
    if (key === "certifications") return Object.values(SE_CERTIFICATIONS).flat();
    if (key === "display_name" || key === "visit_address") return [...own, ...OPENSTREETMAP];
    return own;
  };

  for (const [key, fv] of Object.entries(fields)) {
    if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) continue;
    if (!fv || !Array.isArray(fv.sources) || fv.sources.length === 0) {
      errors.push(`no_source:${key}`);
      continue;
    }
    for (const src of fv.sources) {
      if (src.url === REGISTER_SOURCE) {
        if (!["org_nr", "postal_town", "visit_address"].includes(key)) errors.push(`register_source_not_allowed:${key}`);
        continue;
      }
      const host = hostOf(src.url);
      if (!host) {
        errors.push(`bad_source_url:${key}`);
        continue;
      }
      if (isDenylisted(host) || !hostIn(host, allowedHosts(key))) errors.push(`source_host_not_allowed:${key}:${host}`);
      const quote = normText(src.quote || "");
      if (quote.length < MIN_QUOTE_CHARS) {
        errors.push(`missing_quote:${key}`);
        continue;
      }
      if (quote.length > 400) errors.push(`quote_too_long:${key}`);
      const page = excerptByUrl.get(normUrl(src.url));
      if (!page) errors.push(`quote_url_without_excerpt:${key}`);
      else if (!page.includes(quote)) errors.push(`quote_not_in_excerpt:${key}`);
    }
  }

  // Field-specific rules.
  const str = (k: string): string | null => {
    const v = fields[k]?.value;
    return typeof v === "string" ? v.trim() : null;
  };
  const arr = (k: string): string[] | null => {
    const v = fields[k]?.value;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  };

  if (fields.display_name) {
    const v = str("display_name");
    if (!v || v.length < 2 || v.length > 120) errors.push("bad_value:display_name");
  }
  if (fields.website) {
    const v = str("website");
    if (!v || !hostOf(v) || !(hostOf(v) as string).includes(".")) errors.push("bad_value:website");
    else if (hostIn(hostOf(v) as string, NOT_AN_OWN_SITE)) errors.push("website_is_not_own_site");
    else if (!fields.website.sources.some((s) => hostOf(s.url) === hostOf(v))) errors.push("website_not_sourced_from_itself");
  }
  for (const k of ["business_email", "business_phone"]) {
    if (!fields[k]) continue;
    const v = str(k);
    if (!v) {
      errors.push(`bad_value:${k}`);
      continue;
    }
    if (!websiteHost) {
      errors.push(`${k}_requires_website`);
      continue;
    }
    const own = fields[k].sources.filter((s) => hostOf(s.url) === websiteHost);
    if (own.length === 0) errors.push(`${k}_not_published_on_own_site`);
    if (k === "business_email") {
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) errors.push("bad_value:business_email");
      else if (!own.some((s) => normText(s.quote || "").includes(v.toLowerCase()))) errors.push("business_email_not_in_quote");
    } else {
      const d = phoneDigits(v);
      if (!SWEDISH_PHONE_RE.test(d)) errors.push("bad_value:business_phone");
      else if (!own.some((s) => quotePhoneDigits(s.quote || "").includes(d))) errors.push("business_phone_not_in_quote");
    }
  }
  if (fields.visit_address) {
    const v = fields.visit_address.value as { street?: unknown; postal_code?: unknown; town?: unknown } | null;
    const street = v && typeof v.street === "string" ? v.street.trim() : "";
    if (!street) errors.push("bad_value:visit_address");
    const hosts = new Set<string>();
    for (const s of fields.visit_address.sources) {
      if (s.url === REGISTER_SOURCE) {
        if (unit.street && normText(unit.street) === normText(street)) hosts.add(REGISTER_SOURCE);
        else errors.push("visit_address_register_mismatch");
      } else {
        const h = hostOf(s.url);
        if (h && street && normText(s.quote || "").includes(normText(street))) hosts.add(h);
      }
    }
    if (hosts.size < 2) errors.push("visit_address_needs_two_sources");
  }
  if (fields.postal_town) {
    const v = str("postal_town");
    const reg = fields.postal_town.sources.some((s) => s.url === REGISTER_SOURCE);
    if (!v) errors.push("bad_value:postal_town");
    else if (reg && normText(v) !== normText(unit.postal_town || "")) errors.push("postal_town_register_mismatch");
  }
  if (fields.org_nr) {
    if (str("org_nr")?.replace(/\D/g, "") !== unit.org_nr) errors.push("org_nr_mismatch");
    if (!fields.org_nr.sources.every((s) => s.url === REGISTER_SOURCE)) errors.push("org_nr_must_come_from_register");
  }
  for (const k of ["opening_hours", "season"]) {
    if (!fields[k]) continue;
    const v = str(k);
    if (!v || v.length > 300) errors.push(`bad_value:${k}`);
    // Bind the value to its quote: every number in the value must be in a quote.
    else {
      const quoted = fields[k].sources.map((s) => normText(s.quote || "")).join(" ");
      const nums = v.match(/\d+/g) || [];
      if (nums.some((n) => !new RegExp(`(?<!\\d)${n}(?!\\d)`).test(quoted))) errors.push(`value_not_in_quote:${k}`);
    }
  }
  if (fields.display_name) {
    const v = str("display_name");
    if (v && !fields.display_name.sources.some((s) => normText(s.quote || "").includes(normText(v)))) errors.push("value_not_in_quote:display_name");
  }
  const vocabCheck = (k: string, allowed: readonly string[]) => {
    if (!fields[k]) return;
    const v = arr(k);
    if (!v || v.length === 0) errors.push(`bad_value:${k}`);
    else for (const x of v) if (!allowed.includes(x)) errors.push(`not_in_vocab:${k}:${x}`);
  };
  vocabCheck("product_categories", SE_PRODUCT_CATEGORIES);
  vocabCheck("sales_channels", SE_SALES_CHANNELS);
  if (fields.certifications) {
    const v = arr("certifications");
    if (!v || v.length === 0) errors.push("bad_value:certifications");
    else
      for (const c of v) {
        const hosts = SE_CERTIFICATIONS[c];
        if (!hosts) errors.push(`not_in_vocab:certifications:${c}`);
        else if (!fields.certifications.sources.some((s) => hosts.includes(hostOf(s.url) || ""))) errors.push(`certification_without_register_source:${c}`);
      }
  }

  // Market language: Swedish text must not carry Norwegian/Danish letters.
  for (const k of FREE_TEXT_FIELDS) {
    const v = str(k);
    if (v && /[øæØÆ]/.test(v)) errors.push(`not_swedish:${k}`);
  }

  // Personnummer block over every value and quote (the declared phone number is
  // exempt in any formatting — phone numbers share the shape, see pii.ts).
  const keep = declaredPhoneDigits(fields);
  if (findPersonnummer(JSON.stringify(fields)).some((hit) => !isDeclaredPhoneHit(hit, keep))) errors.push("personnummer_in_fields");

  return { ok: errors.length === 0, errors };
}
