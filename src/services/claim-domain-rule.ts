// ─── Claim domain rule (eierkrav-domeneregel), slice 1 ───────────────────
// dev-request 2026-10-27-rfb-eierkrav-domeneregel-og-cs-sjekkliste (Daniel
// live 2026-10-27, L4, daniel_authorized). Builds on decision 11=A
// (2026-10-17-rfb-claim-verifisering-mot-kjent-kontakt): a claim on a profile
// with NO known farm e-mail used to go straight to the admin queue
// (no_known_email). With CLAIM_DOMAIN_RULE_ENABLED on, before that happens:
//   P1  the claimant's e-mail domain is the domain of the website the profile
//       already has from an INDEPENDENT source (not the owner, not the
//       self-registration; independentWebsiteHost in knowledge-service.ts),
//       not a free-mail domain, and the profile has no owner → the code goes
//       to the claimant's address the same way as rule 1. No queue entry.
//   P2  no independent website (a self-registered profile always counts as
//       that) and the domain is not free-mail and answers on HTTPS → the code
//       goes to the claimant's address. Ownership by code, but is_vetted is
//       never touched and the «Verifisert» badge is withheld (Gate 2 and
//       more: see grantClaimOwnership).
//   P3/P4  free-mail/invalid domain, or a profile that has an owner → the
//       admin queue as before, with a `recommendation` naming the rule.
// Everything that fails or is unsure falls through to the admin queue —
// never toward ownership. Pure helpers here; the DB side is in
// knowledge-service.ts (requestClaimWithDomainRule).

import dns from "dns";
import https from "https";
import net from "net";
import { domainToASCII } from "url";

/** Env kill switch (read at call time; "1" or "true" = on). Default OFF:
 *  the claim flow is as before, only the queue row's `recommendation` is new. */
export const CLAIM_DOMAIN_RULE_FLAG = "CLAIM_DOMAIN_RULE_ENABLED";

export function claimDomainRuleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env[CLAIM_DOMAIN_RULE_FLAG] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** The rule a claim matched (agent_claims.recommendation). On a queue row it
 *  is advice for CS/Daniel; on a code row it records which rule sent it. */
export type ClaimRecommendation =
  | "domain_match_independent"
  | "domain_code_sent"
  | "free_mail_needs_extra"
  | "has_owner"
  | "needs_review";

/** Norwegian text for the admin notice and the queue: the rule, and what
 *  Daniel can do about it. */
export const CLAIM_RECOMMENDATION_LABELS: Record<ClaimRecommendation, string> = {
  domain_match_independent:
    "P1: e-postdomenet er det samme som nettsiden profilen har fra en uavhengig kilde. Kan godkjennes (claim-review-approve).",
  domain_code_sent:
    "P2: e-postdomenet har en fungerende nettside, men er ikke knyttet til profilen fra en uavhengig kilde. Sjekk eget nettsted, Brreg eller Bondens marked før du godkjenner.",
  free_mail_needs_extra:
    "P3: privat eller ugyldig e-postadresse. Krever ekstra bekreftelse: telefon, eller at adressen står på gårdens egen nettside, i Brreg eller i Bondens marked-oppføringen.",
  has_owner:
    "P4: profilen har allerede en eier. Vurder manuelt; eieren beholder tilgangen.",
  needs_review:
    "Ingen regel slo til. Vurder manuelt mot uavhengige kilder (nettside, Brreg, Bondens marked, telefon).",
};

/**
 * Free-mail / ISP mail domains: an address here proves nothing about which
 * business it belongs to, so it never qualifies for P1 or P2 (→ P3). Compared
 * against the address's domain and every parent of it.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  // international
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "protonmail.com", "proton.me", "pm.me", "gmx.com", "gmx.net", "gmx.de", "mail.com", "zoho.com",
  "yandex.com", "yandex.ru", "tutanota.com", "tuta.io", "fastmail.com", "hey.com", "mail.ru", "qq.com",
  // Norwegian free-mail and ISP mail
  "online.no", "live.no", "hotmail.no", "outlook.no", "yahoo.no", "frisurf.no", "start.no", "broadpark.no",
  "getmail.no", "epost.no", "c2i.net", "altibox.no", "lyse.net", "telia.no", "telia.com", "netcom.no",
  "chello.no", "sol.no", "tele2.no", "nextgentel.com", "nextgentel.no", "bluecom.no", "ice.no", "kpnqwest.no",
  "loqal.no", "tdcadsl.no", "tiscali.no", "eunet.no", "frisurf.com", "haugnett.no", "enivest.net", "nkn.no",
  "vikenfiber.no", "tussa.com", "kvinnherad.net", "online.com", "msn.no", "icloud.no", "gmx.no",
  // the same brands under other TLDs (review B1, 2026-10-28); FREE_MAIL_BRANDS
  // below catches any TLD, this list just names the common ones
  "hotmail.se", "hotmail.dk", "hotmail.de", "hotmail.fr", "live.se", "live.dk", "live.co.uk", "outlook.dk",
  "yahoo.se", "yahoo.dk", "yahoo.de", "protonmail.ch", "web.de", "t-online.de",
]);

/**
 * Free-mail brands: a domain whose registrable domain's first label is one of
 * these (hotmail.se, yahoo.fr, gmx.at, t-online.de …) is free-mail whatever
 * its TLD — anyone can get an account there, so it proves nothing (review B1).
 */
export const FREE_MAIL_BRANDS: ReadonlySet<string> = new Set([
  "hotmail", "outlook", "live", "msn", "yahoo", "ymail", "gmail", "googlemail", "gmx", "icloud", "me", "mac",
  "aol", "proton", "protonmail", "pm", "yandex", "mail", "web", "t-online", "orange", "free", "laposte",
  "libero", "seznam", "wp", "tutanota", "tuta", "zoho", "fastmail", "hushmail", "inbox", "online", "start",
  "frisurf", "epost",
]);

/**
 * Website hosts that are platforms, not the farm's own domain: a website
 * there (gard.wixsite.com, facebook.com/gard) says nothing about who owns
 * mail on that domain, so it is never an "independent website" for P1.
 */
export const HOSTED_PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
  "facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "youtube.com",
  "wixsite.com", "wix.com", "squarespace.com", "blogspot.com", "blogger.com", "wordpress.com", "weebly.com",
  "jimdo.com", "jimdofree.com", "jimdosite.com", "webnode.com", "webnode.page", "business.site", "google.com",
  "goo.gl", "linktr.ee", "github.io", "netlify.app", "vercel.app", "myshopify.com", "square.site", "site123.me",
  "hjemmeside.no", "123hjemmeside.no", "bondensmarked.no", "rettfrabonden.com", "rekoringen.no", "mattilsynet.no",
  "brreg.no", "proff.no", "gulesider.no", "1881.no", "tripadvisor.com", "tripadvisor.no", "visitnorway.com",
  "visitnorway.no",
  // more subdomain-based hosting (review N1, 2026-10-28)
  "herokuapp.com", "pages.dev", "web.app", "firebaseapp.com", "azurewebsites.net", "webflow.io", "carrd.co",
  "one.com", "onepage.website", "strikingly.com", "mystrikingly.com", "godaddysites.com", "ueniweb.com",
  "wordpress.org", "wpcomstaging.com", "sites.google.com", "notion.site", "framer.website", "framer.app",
  // umbrella organisations and aggregators: a farm's page there is theirs, not the farm's
  "hanen.no", "lokalmat.no", "matmerk.no", "tine.no", "nortura.no", "bondelaget.no", "smabrukarlaget.no",
  "norsk-landbruk.no", "landbruk.no", "debio.no", "reko.no", "bygdeturisme.no", "norgesvel.no",
  // public sector and research: a page about a farm on their site is theirs
  "kommune.no", "fylkeskommune.no", "regjeringen.no", "statsforvalteren.no", "landbruksdirektoratet.no",
  "innovasjonnorge.no", "nibio.no", "nmbu.no", "uio.no", "uib.no", "ntnu.no", "uit.no", "inn.no", "hvl.no",
  "nav.no", "altinn.no", "norge.no", "stortinget.no", "fylkesmannen.no",
]);

/** TLDs and name patterns that are never one farm's own site (review N1). */
const PLATFORM_TLDS: ReadonlySet<string> = new Set(["gov", "edu", "mil", "int"]);
const PLATFORM_DOMAIN_PATTERNS: readonly RegExp[] = [
  /^visit[a-z0-9-]*\.(?:no|com)$/,   // visitnorway.com, visitoslo.no, visithelgeland.com …
  /^jimdo[a-z0-9-]*\.com$/,          // jimdo.com, jimdofree.com, jimdosite.com …
  /^(?:[a-z0-9-]+\.)?gov\.[a-z]{2}$/, // gov.uk-style government suffixes
];

/**
 * Second-level public suffixes, so a "registrable domain" is one label more
 * (gard.co.uk, gard.priv.no). Deliberately short: the match below also needs
 * the two hosts to be equal or nested, so a geographic suffix not listed here
 * (a.oslo.no vs b.oslo.no) still does not match.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz", "co.jp", "co.za", "com.br",
  "priv.no", "kommune.no", "fhs.no", "vgs.no", "fylkesbibl.no", "folkebibl.no", "idrett.no", "museum.no",
  "herad.no", "stat.no", "mil.no", "dep.no",
]);

/** Names that never get an outgoing request (RFC 2606/6761 and common internal TLDs). */
const NON_PUBLIC_TLDS: ReadonlySet<string> = new Set([
  "localhost", "local", "internal", "intranet", "lan", "home", "corp", "localdomain", "arpa", "invalid",
  "test", "example", "onion", "private", "home.arpa",
]);

/**
 * A hostname normalized for comparison: lower case, IDN → punycode, trailing
 * dot(s) removed, then checked to be a plain public-looking DNS name of 2+
 * labels with an alphabetic TLD. IP literals (also bracketed), ports, paths,
 * single labels and anything malformed → null.
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let h = raw.trim().toLowerCase();
  if (!h || h.length > 253 || /[\s:/\\[\]@?#%]/.test(h)) return null;
  h = h.replace(/\.+$/, "");
  if (!h || net.isIP(h) !== 0) return null;
  const ascii = domainToASCII(h);
  if (!ascii || net.isIP(ascii) !== 0) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  }
  const tld = labels[labels.length - 1]!;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return null; // all-numeric = an IP in disguise
  return ascii;
}

/** The domain part of an e-mail address, normalized (normalizeHost), or null. */
export function emailDomain(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  return normalizeHost(email.slice(at + 1));
}

/** The host of a website value ("gard.no", "https://www.gard.no/om"), or null. */
export function websiteHost(website: unknown): string | null {
  if (typeof website !== "string" || !website.trim()) return null;
  const raw = website.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return normalizeHost(u.hostname);
}

/** Strips one leading "www." (also "www2." etc. is NOT stripped: keep it simple). */
function stripWww(host: string): string {
  return host.startsWith("www.") && host.split(".").length > 2 ? host.slice(4) : host;
}

/** The registrable domain of a normalized host: its last two labels, or three
 *  under a listed second-level suffix (gard.co.uk). null for a bare suffix. */
export function registrableDomain(host: string): string | null {
  const labels = host.split(".");
  const last2 = labels.slice(-2).join(".");
  const n = MULTI_LABEL_SUFFIXES.has(last2) ? 3 : 2;
  if (labels.length < n) return null;
  return labels.slice(-n).join(".");
}

/** True when `host` or any parent of it is in `set`. */
function inDomainSet(host: string, set: ReadonlySet<string>): boolean {
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (set.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

export function isFreeMailDomain(domain: string): boolean {
  if (inDomainSet(domain, FREE_MAIL_DOMAINS)) return true;
  const reg = registrableDomain(domain);
  return reg !== null && FREE_MAIL_BRANDS.has(reg.split(".")[0]!);
}

/** A hosting/social platform, umbrella organisation, aggregator or public-
 *  sector host: never an independent website for P1. */
export function isHostedPlatformHost(host: string): boolean {
  if (inDomainSet(host, HOSTED_PLATFORM_DOMAINS)) return true;
  const labels = host.split(".");
  if (PLATFORM_TLDS.has(labels[labels.length - 1]!)) return true;
  const reg = registrableDomain(host);
  const last2 = labels.slice(-2).join(".");
  return PLATFORM_DOMAIN_PATTERNS.some((re) => re.test(last2) || (reg !== null && re.test(reg)));
}

/** Paths that still count as the site's front page (language or CMS roots). */
const ROOT_PATHS: ReadonlySet<string> = new Set([
  "", "/no", "/nb", "/nn", "/en", "/wp", "/home", "/hjem", "/forside", "/index.html", "/index.htm", "/index.php",
]);

/**
 * Is the website value the domain's front page (empty path, "/", or one
 * index-ish segment such as /no, /en, /wp, /home)? A deep page
 * (kommune.no/naering/gard) is someone's page ABOUT the farm, so P1 only
 * trusts a front page (review N1). Query and fragment are ignored.
 */
export function isRootWebsite(website: unknown): boolean {
  if (typeof website !== "string" || !website.trim()) return false;
  const raw = website.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return false;
  }
  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  return ROOT_PATHS.has(path);
}

/**
 * Does an e-mail domain belong to the same site as a website host? Both are
 * normalized and stripped of a leading "www."; they match when they are
 * equal, or one is a subdomain of the other (post.gard.no ↔ www.gard.no),
 * and the shorter one is at least a registrable domain (never just "no" or
 * "co.uk"). Conservative on purpose: siblings (a.gard.no vs b.gard.no) do not
 * match.
 */
export function emailDomainMatchesWebsite(emailDom: string, siteHost: string): boolean {
  const e = stripWww(emailDom);
  const s = stripWww(siteHost);
  const nested = e === s || e.endsWith(`.${s}`) || s.endsWith(`.${e}`);
  if (!nested) return false;
  const shorter = e.length <= s.length ? e : s;
  const reg = registrableDomain(shorter);
  return reg !== null && (shorter === reg || shorter.endsWith(`.${reg}`));
}

/** May the server make a request to this domain at all (the HTTPS probe)? */
export function isProbeableDomain(domain: string): boolean {
  const host = normalizeHost(domain);
  if (!host || host !== domain) return false;
  const labels = host.split(".");
  const tld = labels[labels.length - 1]!;
  const last2 = labels.slice(-2).join(".");
  return !NON_PUBLIC_TLDS.has(tld) && !NON_PUBLIC_TLDS.has(last2) && registrableDomain(host) !== null;
}

/** A public unicast address (the probe refuses anything else after DNS). */
export function isPublicIp(addr: string): boolean {
  const kind = net.isIP(addr);
  if (kind === 4) {
    const o = addr.split(".").map(Number);
    const [a, b] = o as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (kind === 6) {
    const g = expandIpv6(addr);
    if (!g) return false;
    // ::/8 — unspecified, loopback, IPv4-compatible (::/96) and IPv4-mapped
    // (::ffff:0:0/96) all start with a zero group: refused outright, whatever
    // IPv4 address they carry (review N4).
    if (g[0] === 0) return false;
    if (g[0] === 0x2002) return false;                  // 6to4 2002::/16
    if (g[0] === 0x2001 && g[1] === 0) return false;    // Teredo 2001::/32
    if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
    if (g[0] === 0x64 && g[1] === 0xff9b) return false; // NAT64 64:ff9b::/96 (and /48)
    if ((g[0]! & 0xfe00) === 0xfc00) return false;      // unique-local fc00::/7
    if ((g[0]! & 0xffc0) === 0xfe80) return false;      // link-local fe80::/10
    if ((g[0]! & 0xffc0) === 0xfec0) return false;      // site-local fec0::/10
    if ((g[0]! & 0xff00) === 0xff00) return false;      // multicast ff00::/8
    return true;
  }
  return false;
}

/** An IPv6 address as its 8 16-bit groups (also "::" and an IPv4 tail), or null. */
function expandIpv6(addr: string): number[] | null {
  let v = addr.toLowerCase().replace(/%.*$/, "");
  const v4 = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (net.isIP(v4[2]!) !== 4) return null;
    const o = v4[2]!.split(".").map(Number);
    v = `${v4[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map((x) => parseInt(x, 16));
}

/** The HTTPS probe: does `https://<domain>/` give any HTTP answer below 500? */
export type DomainHttpsCheck = (domain: string) => Promise<boolean>;

export const DOMAIN_HTTPS_TIMEOUT_MS = 4000;

/**
 * Default probe: one HEAD to https://<domain>/ (port 443, no redirect
 * followed, ~4 s), answered true for any status < 500. The name is checked
 * by isProbeableDomain first, and the DNS answer is checked inside the
 * request's own lookup, so the connection never goes to a private, loopback,
 * link-local or metadata address (also not by DNS rebinding). Any error or
 * timeout → false.
 */
export function defaultDomainAnswersHttps(domain: string): Promise<boolean> {
  if (!isProbeableDomain(domain)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    const safeLookup = (hostname: string, options: dns.LookupOptions, cb: (...args: any[]) => void): void => {
      dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const list = (addrs as dns.LookupAddress[]) ?? [];
        if (!list.length || list.some((a) => !isPublicIp(a.address))) {
          return cb(Object.assign(new Error(`non-public address for ${hostname}`), { code: "ENOTFOUND" }));
        }
        if ((options as { all?: boolean }).all) return cb(null, list);
        return cb(null, list[0]!.address, list[0]!.family);
      });
    };
    try {
      const req = https.request({
        host: domain, port: 443, path: "/", method: "HEAD", servername: domain,
        timeout: DOMAIN_HTTPS_TIMEOUT_MS, lookup: safeLookup as any, agent: false,
        headers: { "User-Agent": "Lokal-RFB-ClaimCheck/1.0 (+https://rettfrabonden.com)" },
      }, (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        req.destroy();
        finish(status > 0 && status < 500);
      });
      const hard = setTimeout(() => { req.destroy(); finish(false); }, DOMAIN_HTTPS_TIMEOUT_MS + 500);
      hard.unref?.();
      req.on("timeout", () => { req.destroy(); finish(false); });
      req.on("error", () => finish(false));
      req.on("close", () => { clearTimeout(hard); finish(false); });
      req.end();
    } catch {
      finish(false);
    }
  });
}

let httpsCheckImpl: DomainHttpsCheck = defaultDomainAnswersHttps;

/** The probe the claim route uses (defaultDomainAnswersHttps unless a test set one). */
export function getDomainHttpsCheck(): DomainHttpsCheck {
  return httpsCheckImpl;
}

/** Tests only: replace the probe (null restores the default). */
export function __setDomainHttpsCheckForTesting(fn: DomainHttpsCheck | null): void {
  httpsCheckImpl = fn ?? defaultDomainAnswersHttps;
}
