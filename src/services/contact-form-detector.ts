// ─── Contact-form detector (offline, pure) ──────────────────────────────────
//
// dev-request 2026-10-03-rfb-kontaktskjema-henvendelser, slice 1 (endring 1,
// kartlegging): read a producer page's HTML and describe each contact form on
// it — action, method, charset, fields with a classified role, captcha, and
// whether the form is on the producer's own site — plus the reason a later
// submission lane would have to skip it.
//
// This module only READS a string. It submits nothing, fetches nothing, opens
// no DB, and has no flag or route. robots.txt is not re-implemented here: the
// pure parser in ./product-import/robots.ts (parseRobotsTxt + isPathAllowed)
// is the one to use for the form's action URL.
//
// No HTML parser is a dependency of this repo, so the markup is read with a
// small hand-written tokenizer that is linear in the input (see tokenize()).
// It is deliberately conservative: anything it is unsure about makes a form
// MORE likely to be skipped (captcha anywhere on the page, a "*" in a label =
// required, an unknown producer host = not same-site, a submit button posting
// elsewhere = not same-site, a page that ends inside a tag or is cut at the
// size limit = not same-site, <svg>/<math>, an undecodable character
// reference in a URL, a non-default port = not same-site), never less.
//
// "Same site" means the producer's OWN host (leading "www." stripped) or a
// subdomain of it — never a sibling, a parent, or anything else that merely
// shares a registrable domain or hosting suffix (review B2, 2026-11-05) —
// and only when the producer's website is a front page (review r2 B2).

import { isHostedPlatformHost, isRootWebsite, normalizeHost, registrableDomain, stripWww, websiteHost } from "./claim-domain-rule";

export type ContactFieldRole =
  | "name"
  | "email"
  | "phone"
  | "company"
  | "subject"
  | "message"
  | "consent_required_own_data"
  | "optional_checkbox"
  | "hidden"
  | "other";

export type ContactFormSkipReason =
  | "captcha"
  | "annet_domene"
  | "telefon_paakrevd"
  | "melding_for_lang"
  | "mangler_meldingsfelt"
  | "mangler_epostfelt"
  | "metode_dialog";

export interface ContactFormField {
  /** The `name` attribute (what the form submits), or null when absent. */
  name: string | null;
  /** Lower-cased input type; "textarea" / "select" for those elements. */
  type: string;
  required: boolean;
  maxLength: number | null;
  role: ContactFieldRole;
  /** Label / placeholder / aria-label text used for classification (trimmed). */
  label: string;
}

/** A submit control (`<button>`, `<input type=submit|image>`) that overrides the form's action or method. */
export interface ContactFormSubmitAction {
  /** Absolute URL the control submits to (its `formaction`, else the form's action), or null if unresolvable. */
  action: string | null;
  /** Its `formmethod`, lower case, or null when it has none (the form's method applies). */
  method: "get" | "post" | "dialog" | null;
}

export interface DetectedContactForm {
  /** 0-based position among ALL <form> elements on the page. */
  index: number;
  /** Absolute action URL (the page URL when absent/empty), resolved against <base href>. */
  action: string | null;
  method: "get" | "post" | "dialog";
  /** First token of accept-charset, lower case, or null. */
  acceptCharset: string | null;
  fields: ContactFormField[];
  /** Submit controls with their own `formaction` / `formmethod` (review B1). */
  submitActions: ContactFormSubmitAction[];
  captcha: boolean;
  /** Page, form action AND every submit control's action are on the producer's own host. */
  sameSiteAsProducer: boolean;
  messageMaxLength: number | null;
  phoneRequired: boolean;
  hasMessageField: boolean;
  hasEmailField: boolean;
  /** Names/labels of required fields the rules cannot fill ("other", or a required optional-type box such as newsletter). */
  unfillableRequired: string[];
  skipReason: ContactFormSkipReason | null;
}

export interface ContactFormSurvey {
  pageUrl: string;
  pageHost: string | null;
  /** The producer's own host ("www." stripped), or null (missing/unparseable/hosted platform/bare suffix). */
  producerDomain: string | null;
  /** Captcha script/widget found anywhere on the page (applies to every form). */
  pageCaptcha: boolean;
  /** <meta charset> / http-equiv charset of the page, lower case, or null. */
  pageCharset: string | null;
  /** Number of <form> elements on the page (contact or not). */
  formsTotal: number;
  /** Forms that have a message field and are not search/login forms. */
  forms: DetectedContactForm[];
}

/** Pages larger than this are only read up to this many characters. */
export const CONTACT_FORM_MAX_HTML_CHARS = 2_000_000;

// ── Tokenizer ───────────────────────────────────────────────────────────────

/** Decoded attribute values (first wins). `ambiguous` names attributes whose character references could not be decoded with certainty (review r3 B3). */
interface Attrs extends Map<string, string> {
  ambiguous?: Set<string>;
}

interface Token {
  kind: "open" | "close" | "text";
  /** Tag name; for a text token the raw-text element it sits in ("script", "title" …), else "". */
  tag: string;
  attrs: Attrs;
  text: string;
}

const ENTITY: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  AMP: "&", LT: "<", GT: ">", QUOT: '"',
  aelig: "æ", oslash: "ø", aring: "å", AElig: "Æ", Oslash: "Ø", Aring: "Å",
  laquo: "«", raquo: "»", mdash: "—", ndash: "–",
};

/** The names in ENTITY that HTML also decodes WITHOUT a trailing ";" (legacy Latin-1 references). */
const LEGACY_NO_SEMI: ReadonlySet<string> = new Set([
  "amp", "lt", "gt", "quot", "nbsp", "AMP", "LT", "GT", "QUOT",
  "aelig", "oslash", "aring", "AElig", "Oslash", "Aring", "laquo", "raquo",
]);

/** Longest semicolon-less (legacy) name in the HTML entity table ("middot", "plusmn" …). */
const LEGACY_MAX_LEN = 6;

/**
 * One alternative per character-reference shape; every quantified run is
 * followed only by an optional ";", so a global scan is linear (no backtracking
 * between runs).
 */
const CHAR_REF_RE = /&(?:#[xX]([0-9a-fA-F]+)(;?)|#([0-9]+)(;?)|([A-Za-z][A-Za-z0-9]*)(;?))/g;

interface Decoded {
  text: string;
  /** A reference the browser may decode differently from us (unknown named reference, C1 remap). */
  ambiguous: boolean;
}

/**
 * Decode character references as the HTML tokenizer does (review r3 B3):
 *   - numeric references (decimal or hex) with ANY number of leading zeros and
 *     with or without ";" ("&#47", "&#00000000047;", "&#x2F");
 *     0, surrogates and values above U+10FFFF become U+FFFD;
 *   - named references from the small ENTITY table; without ";" only the
 *     legacy ones, and in an attribute not when followed by "=" (HTML rule).
 * A reference we cannot decode with certainty — a named reference not in
 * ENTITY ("&sol;", "&colon;"), a short semicolon-less name that might be a
 * legacy one, a C1 code point the browser remaps — sets `ambiguous`; callers
 * treat an ambiguous URL as unknown (fail closed). Decoding is one pass, so
 * "&amp;#47;" is "&#47;" (as in a browser), not "/".
 */
function decodeRefs(s: string, inAttribute: boolean): Decoded {
  if (s.indexOf("&") < 0) return { text: s, ambiguous: false };
  let ambiguous = false;
  CHAR_REF_RE.lastIndex = 0;
  const text = s.replace(
    CHAR_REF_RE,
    (m: string, hex: string | undefined, _hs: string, dec: string | undefined, _ds: string, name: string | undefined, nameSemi: string, offset: number) => {
      if (hex !== undefined || dec !== undefined) {
        const digits = (hex ?? dec)!.replace(/^0+/, "");
        const cp = digits.length > 8 ? Infinity : digits ? parseInt(digits, hex !== undefined ? 16 : 10) : 0;
        if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
        if (cp >= 0x80 && cp <= 0x9f) {
          ambiguous = true; // windows-1252 remap in browsers; not modelled
          return "\ufffd";
        }
        return String.fromCodePoint(cp);
      }
      const nm = name!;
      if (nameSemi) {
        if (Object.prototype.hasOwnProperty.call(ENTITY, nm)) return ENTITY[nm]!;
        ambiguous = true; // a named reference we do not know ("&sol;", "&colon;" …)
        return m;
      }
      // Semicolon-less: `nm` is the whole alphanumeric run, so the next character is not alphanumeric.
      if (inAttribute && s.charCodeAt(offset + m.length) === 61 /* = */) return m; // never decoded in an attribute
      if (LEGACY_NO_SEMI.has(nm)) return ENTITY[nm]!;
      if (nm.length <= LEGACY_MAX_LEN) ambiguous = true; // could be a legacy name we do not list
      return m; // longer runs: a legacy prefix would be followed by an alphanumeric → not decoded
    },
  );
  return { text, ambiguous };
}

export function decodeEntities(s: string): string {
  return decodeRefs(s, false).text;
}

/** ASCII-only lower case, as HTML keyword matching ("İ"/"K" are not folded to ASCII). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (c) => c.toLowerCase());
}

/**
 * Elements whose content is not markup: raw text (script, style, xmp, iframe,
 * noembed, noframes, noscript — a scripting browser), escapable raw text
 * (title, textarea) and template (inert content). Their content becomes one
 * text token up to the matching close tag (review N5).
 */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
  "script", "style", "textarea", "title", "xmp", "noscript", "template", "iframe", "noembed", "noframes",
]);

/** HTML whitespace (CR included: the input is not newline-normalized). */
function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

interface TagRest {
  /** Index just past the ">" that ends the tag. */
  end: number;
  attrs: Attrs;
}

/**
 * Read the rest of a tag — attributes up to the ">" that ends it — starting
 * right after the tag name, with the HTML tokenizer's attribute states
 * (review r2 B1). As in a browser, "<", quotes not right after "=", "=" at
 * the start of a name and "`" are ordinary characters; only ">" outside a
 * quoted value ends the tag. Returns null when the input ends inside the tag
 * (a browser drops such a tag and everything after it).
 *
 * Linear in the characters consumed: one forward pass, quoted values are
 * skipped with indexOf.
 */
function readTagRest(html: string, p: number): TagRest | null {
  const n = html.length;
  const attrs: Attrs = new Map();
  let name = "";
  let haveAttr = false;
  const commit = (value: string): void => {
    if (haveAttr && !attrs.has(name)) {
      // first wins, as in HTML
      const d = decodeRefs(value, true);
      attrs.set(name, d.text);
      if (d.ambiguous) (attrs.ambiguous ??= new Set()).add(name);
    }
    haveAttr = false;
    name = "";
  };
  // States: 0 before-attr-name, 1 attr-name, 2 after-attr-name, 3 before-attr-value,
  // 4 after-quoted-value, 5 self-closing-start.
  let state = 0;
  while (p < n) {
    const c = html.charCodeAt(p);
    switch (state) {
      case 0: // before attribute name
        if (isWs(c)) p++;
        else if (c === 47 /* / */) { state = 5; p++; }
        else if (c === 62 /* > */) return { end: p + 1, attrs };
        else { haveAttr = true; name = String.fromCharCode(c).toLowerCase(); state = 1; p++; } // "=" too
        break;
      case 1: // attribute name
        if (isWs(c)) { state = 2; p++; }
        else if (c === 47) { commit(""); state = 5; p++; }
        else if (c === 62) { commit(""); return { end: p + 1, attrs }; }
        else if (c === 61 /* = */) { state = 3; p++; }
        else { name += String.fromCharCode(c).toLowerCase(); p++; }
        break;
      case 2: // after attribute name
        if (isWs(c)) p++;
        else if (c === 47) { commit(""); state = 5; p++; }
        else if (c === 61) { state = 3; p++; }
        else if (c === 62) { commit(""); return { end: p + 1, attrs }; }
        else { commit(""); state = 0; }
        break;
      case 3: { // before attribute value
        if (isWs(c)) { p++; break; }
        if (c === 34 /* " */ || c === 39 /* ' */) {
          const close = html.indexOf(c === 34 ? '"' : "'", p + 1);
          if (close < 0) return null;
          commit(html.slice(p + 1, close));
          state = 4;
          p = close + 1;
          break;
        }
        if (c === 62) { commit(""); return { end: p + 1, attrs }; }
        // Unquoted value: runs to whitespace or ">" ("<", quotes, "=" are plain).
        let j = p;
        while (j < n && !isWs(html.charCodeAt(j)) && html.charCodeAt(j) !== 62) j++;
        if (j >= n) return null;
        commit(html.slice(p, j));
        if (html.charCodeAt(j) === 62) return { end: j + 1, attrs };
        state = 0;
        p = j + 1;
        break;
      }
      case 4: // after a quoted value
        if (isWs(c)) { state = 0; p++; }
        else if (c === 47) { state = 5; p++; }
        else if (c === 62) return { end: p + 1, attrs };
        else state = 0;
        break;
      default: // self-closing start tag
        if (c === 62) return { end: p + 1, attrs };
        state = 0;
    }
  }
  return null;
}

interface Tokenized {
  tokens: Token[];
  /** The input ended inside a tag: a browser drops it and everything after it, so nothing after can be trusted. */
  unterminatedTag: boolean;
}

/**
 * Tokenize `html` into open/close tags and text, following the HTML
 * tokenizer where it matters for forms (review r2 B1):
 *   - a tag name is a letter followed by anything but whitespace, "/" or ">"
 *     (so `</form_x>` is not `</form>`);
 *   - attributes are read by readTagRest(): an unquoted "<" inside a tag is
 *     a plain character, the tag ends at the first ">" outside a quoted value;
 *   - comments end at the first "-->" or "--!>" ("<!-->", "<!--->" are empty);
 *     `<!…>`, `<?…>` and `</` + non-letter are bogus comments up to the next
 *     ">"; both are dropped; `<` + anything else is text;
 *   - raw-text element bodies are one text token; `<plaintext>` makes the rest
 *     of the document text.
 * A tag the input ends inside stops tokenizing and sets `unterminatedTag`
 * (the caller fails closed on it).
 *
 * Linear time: every successful tag read moves the cursor past its ">", and
 * the first failed read ends tokenizing.
 */
function tokenize(html: string): Tokenized {
  const tokens: Token[] = [];
  const n = html.length;
  let unterminatedTag = false;

  let i = 0;
  let textStart = 0;
  // Next "-->" / "--!>" at or after a position, memoised so many comments stay linear (review r3 B1).
  let nextDashGt = -2;
  let nextDashBangGt = -2;
  const commentEnd = (from: number): number => {
    if (nextDashGt !== -1 && nextDashGt < from) nextDashGt = html.indexOf("-->", from);
    if (nextDashBangGt !== -1 && nextDashBangGt < from) nextDashBangGt = html.indexOf("--!>", from);
    const a = nextDashGt < 0 ? Infinity : nextDashGt + 3;
    const b = nextDashBangGt < 0 ? Infinity : nextDashBangGt + 4;
    const e = Math.min(a, b);
    return e === Infinity ? n : e; // an unclosed comment runs to the end
  };
  const pushText = (end: number, tag = ""): void => {
    if (end > textStart) tokens.push({ kind: "text", tag, attrs: new Map(), text: html.slice(textStart, end) });
  };
  /** Scan a tag name starting at `p` (a letter); returns its end. */
  const nameEndAt = (p: number): number => {
    while (p < n) {
      const c = html.charCodeAt(p);
      if (isWs(c) || c === 47 || c === 62) break;
      p++;
    }
    return p;
  };

  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      pushText(lt);
      // "<!-->" and "<!--->" are empty comments; otherwise the comment ends at
      // the FIRST "-->" or "--!>" (the HTML comment-end-bang state, review r3 B1).
      let end: number;
      if (html.startsWith("<!-->", lt)) end = lt + 5;
      else if (html.startsWith("<!--->", lt)) end = lt + 6;
      else end = commentEnd(lt + 4);
      i = textStart = end;
      continue;
    }
    const c1 = html.charCodeAt(lt + 1);
    const isClose = c1 === 47; /* / */
    const c2 = isClose ? html.charCodeAt(lt + 2) : c1;
    if (c1 === 33 /* ! */ || c1 === 63 /* ? */ || (isClose && lt + 2 < n && !isAsciiAlpha(c2) && c2 !== 62)) {
      // Bogus comment (doctype included): dropped up to the next ">".
      pushText(lt);
      const gt = html.indexOf(">", lt + 2);
      i = textStart = gt < 0 ? n : gt + 1;
      continue;
    }
    if (isClose && c2 === 62) {
      pushText(lt); // "</>" is dropped
      i = textStart = lt + 3;
      continue;
    }
    if (!isAsciiAlpha(c2)) {
      i = lt + 1; // "<" + anything else is text
      continue;
    }
    const nameStart = lt + (isClose ? 2 : 1);
    const nameEnd = nameEndAt(nameStart);
    const rest = nameEnd < n ? readTagRest(html, nameEnd) : null;
    if (!rest) {
      pushText(lt);
      textStart = n;
      unterminatedTag = true;
      break;
    }
    pushText(lt);
    const tag = html.slice(nameStart, nameEnd).toLowerCase();
    i = textStart = rest.end;
    if (isClose) {
      tokens.push({ kind: "close", tag, attrs: new Map(), text: "" });
      continue;
    }
    tokens.push({ kind: "open", tag, attrs: rest.attrs, text: "" });
    if (tag === "plaintext") {
      pushText(n, tag);
      i = textStart = n;
      break;
    }
    if (RAW_TEXT_TAGS.has(tag)) {
      // Content up to "</tag" followed by whitespace, "/" or ">", then the end of that close tag.
      const closeRe = new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, "gi");
      closeRe.lastIndex = i;
      const c = closeRe.exec(html);
      if (!c) {
        pushText(n, tag); // unclosed: the rest of the document is its content
        i = textStart = n;
        break;
      }
      const closeRest = readTagRest(html, c.index + 2 + tag.length);
      pushText(c.index, tag);
      if (!closeRest) {
        textStart = n;
        unterminatedTag = true;
        break;
      }
      tokens.push({ kind: "close", tag, attrs: new Map(), text: "" });
      i = textStart = closeRest.end;
    }
  }
  pushText(n);
  return { tokens, unterminatedTag };
}

// ── Classification ──────────────────────────────────────────────────────────

const CAPTCHA_NAME_RE = /captcha|g-recaptcha|h-captcha|cf-turnstile|frc-/i;
const CAPTCHA_CLASS_RE = /(?:^|\s)(?:g-recaptcha|h-captcha|cf-turnstile|frc-captcha|[\w-]*captcha[\w-]*)(?:\s|$)/i;
/** script / iframe / link / img URLs of captcha providers (review N2: ALTCHA, Arkose/FunCaptcha, friendly-challenge). */
const CAPTCHA_SCRIPT_SRC_RE =
  /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com\/turnstile|friendlycaptcha|friendly-challenge|frc-captcha|captcha|\baltcha|arkoselabs|funcaptcha/i;
const CAPTCHA_INLINE_RE =
  /grecaptcha|hcaptcha|turnstile\.render|friendlychallenge|friendly-challenge|data-sitekey|\baltcha|arkoselabs|arkoseenforcement|funcaptcha/i;
/** Custom-element captcha widgets: <altcha-widget>, <mt-captcha> … */
const CAPTCHA_TAG_RE = /altcha|captcha/i;

const RE_EMAIL = /e-?post|e-?mail|\bmail\b|epost/i;
const RE_PHONE = /telefon|\btlf|mobil|phone|\btel\b|\btelephone/i;
const RE_COMPANY = /firma|bedrift|company|organisa[st]ion|virksomhet|foretak|selskap/i;
const RE_SUBJECT = /emne|subject|tittel|\btopic|regarding|anledning|\bsak\b|overskrift/i;
const RE_MESSAGE = /melding|beskjed|message|kommentar|comment|henvendelse|sp(?:ø|o)rsm(?:å|a)l|question|enquiry|inquiry|\bbody\b|\btext\b|tekst|your-message/i;
const RE_NAME = /navn|\bname\b|fullname|full-name|firstname|first-name|lastname|last-name|your-name|_name\b|-name\b|name_|fornavn|etternavn/i;
const RE_NEWSLETTER = /nyhetsbrev|newsletter|markedsf(?:ø|o)ring|marketing|abonn|subscri|tilbud|kampanje|reklame|offers?\b|updates?\b|oppdatering/i;
const RE_OWN_DATA_CONSENT = /samtykke|consent|personvern|privacy|gdpr|lagr(?:es|e|ing)|\bstored?\b|behandl|opplysning|personal data|data protection|personopplysning/i;

function attrHint(a: Attrs): string {
  return [a.get("name"), a.get("id"), a.get("placeholder"), a.get("aria-label"), a.get("title"), a.get("autocomplete")]
    .filter((v): v is string => !!v)
    .join(" ");
}

function classify(type: string, a: Attrs, label: string): ContactFieldRole {
  const hint = `${attrHint(a)} ${label}`;
  const ac = (a.get("autocomplete") || "").toLowerCase();
  if (type === "hidden") return "hidden";
  if (CAPTCHA_NAME_RE.test(a.get("name") || "")) return "other";
  if (type === "checkbox") {
    if (RE_NEWSLETTER.test(hint)) return "optional_checkbox";
    const req = isRequired(a, label);
    if (req && RE_OWN_DATA_CONSENT.test(hint)) return "consent_required_own_data";
    return req ? "other" : "optional_checkbox";
  }
  if (type === "radio" || type === "file" || type === "password" || type === "search") return "other";
  if (type === "email" || ac === "email") return "email";
  if (type === "tel" || ac === "tel") return "phone";
  if (type === "textarea") return "message";
  if (RE_EMAIL.test(hint)) return "email";
  if (RE_PHONE.test(hint)) return "phone";
  if (RE_COMPANY.test(hint) || ac === "organization") return "company";
  if (RE_SUBJECT.test(hint)) return "subject";
  if (type !== "select" && RE_MESSAGE.test(hint)) return "message";
  if (type !== "select" && (RE_NAME.test(hint) || ac === "name" || ac === "given-name" || ac === "family-name")) {
    return "name";
  }
  return "other";
}

function isRequired(a: Attrs, label: string): boolean {
  if (a.has("required")) return true;
  if ((a.get("aria-required") || "").toLowerCase() === "true") return true;
  if (/(?:^|[\s_-])(?:required|validates-as-required|is-required|gfield_contains_required)(?:\s|$)/i.test(a.get("class") || "")) {
    return true;
  }
  return /\*/.test(label);
}

/**
 * `maxlength` by the HTML rules for non-negative integers (review N4):
 * leading whitespace, optional sign, then the leading digits ("10.5" and
 * "10abc" → 10). No digits, a negative value or an unsafe integer → null.
 */
export function parseMaxLength(value: string | undefined): number | null {
  const m = /^[\t\n\f\r ]*([+-]?)(\d+)/.exec(value || "");
  if (!m) return null;
  const v = parseInt(m[2]!, 10);
  if (!Number.isSafeInteger(v)) return null;
  if (m[1] === "-" && v !== 0) return null;
  return v;
}

function cleanText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

/**
 * The producer's own host with a leading "www." stripped, or null: website
 * missing or unparseable, a hosted/social platform (never the producer's own
 * site — isHostedPlatformHost, as in claim-domain-rule), a bare public
 * suffix such as "co.uk", or a website that is not a front page.
 *
 * Same precedence as P1 in claim-domain-rule (review r2 B2): only a ROOT
 * website (isRootWebsite: empty path, "/", or /no, /en, /home …) makes its
 * host the producer's own. A website with a path on an unknown host
 * (lokalmatportal.no/produsent/gard) is a page ABOUT the farm on someone
 * else's site, so the whole host must not count as the producer's.
 */
export function producerOwnHost(producerWebsite: string): string | null {
  const host = websiteHost(producerWebsite);
  if (!host || isHostedPlatformHost(host)) return null;
  if (!isRootWebsite(producerWebsite)) return null;
  const own = stripWww(host);
  if (registrableDomain(own) === null) return null;
  return own;
}

/**
 * Does `url` (http/https, no userinfo) live on the producer's own host
 * `ownHost` or a subdomain of it? Siblings (shop.gard.no for sub.gard.no),
 * parents (oslo.no for a.oslo.no) and other tenants of a shared suffix
 * (other.webador.no for gard.webador.no) do NOT match (review B2). PURE.
 */
export function urlIsOnProducerHost(url: string | null, ownHost: string | null): boolean {
  if (!url || !ownHost) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port) return false; // a non-default port is another origin (review r3 N3); default ports read as ""
  const host = normalizeHost(u.hostname);
  if (!host) return false;
  if (host !== ownHost && isHostedPlatformHost(host)) return false;
  return host === ownHost || host.endsWith(`.${ownHost}`);
}

// ── Detector ────────────────────────────────────────────────────────────────

interface RawField {
  type: string;
  attrs: Attrs;
  labelText: string;
}

interface RawForm {
  attrs: Attrs;
  fields: RawField[];
  /** Attributes of the form's submit controls (button / input type=submit|image). */
  submitters: Attrs[];
  captcha: boolean;
  search: boolean;
}

function checkMessageLength(messageLength: number): void {
  if (typeof messageLength !== "number" || !Number.isFinite(messageLength) || messageLength < 0) {
    throw new RangeError(`contact-form-detector: messageLength must be a finite number >= 0, got ${String(messageLength)}`);
  }
}

/** Input types HTML knows; any other value (" email", "tex t") is the Text state. */
const INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden", "text", "search", "tel", "url", "email", "password", "date", "month", "week", "time",
  "datetime-local", "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button",
]);

/** An input's type state: ASCII case-insensitive, NOT trimmed (review r3 B4); unknown/missing = "text". */
function inputTypeOf(a: Attrs): string {
  const t = asciiLower(a.get("type") ?? "text");
  return INPUT_TYPES.has(t) ? t : "text";
}

/**
 * Is this start tag a submit button? `<button>` unless its type is EXACTLY
 * (ASCII case-insensitively) "button" or "reset" — "button " or "&#9;button"
 * is an invalid value, i.e. submit (review r3 B4); `<input>` only when its
 * type is exactly "submit" or "image".
 */
function isSubmitControl(tag: string, a: Attrs): boolean {
  if (tag === "button") {
    const t = asciiLower(a.get("type") ?? "submit");
    return t !== "button" && t !== "reset";
  }
  if (tag === "input") {
    const t = inputTypeOf(a);
    return t === "submit" || t === "image";
  }
  return false;
}

/**
 * A URL attribute's raw value: undefined when absent, null when a character
 * reference in it could not be decoded with certainty (review r3 B3) — the
 * caller treats null as an unknown destination.
 */
function urlAttr(a: Attrs, name: string): string | undefined | null {
  if (!a.has(name)) return undefined;
  return a.ambiguous?.has(name) ? null : a.get(name)!;
}

/**
 * <noscript> content is text to a scripting browser but markup without
 * scripting. If it holds anything that could change where a form posts — a
 * form tag, a submit button, a <base> — no form on the page is trusted
 * (review r3 N1). Linear: the content is tokenized once.
 */
function noscriptHasFormMarkup(text: string): boolean {
  const { tokens, unterminatedTag } = tokenize(text);
  if (unterminatedTag) return true;
  return tokens.some(
    (t) => (t.kind !== "text" && t.tag === "form") || (t.kind === "open" && (t.tag === "base" || isSubmitControl(t.tag, t.attrs))),
  );
}

/** Elements that bound the default "in scope" check: a `</form>` while one opened inside the form is still open does not end it. */
const FORM_SCOPE_BOUNDARY: ReadonlySet<string> = new Set(["applet", "object", "marquee", "table", "td", "th", "caption"]);

function captchaUrl(a: Attrs): boolean {
  return ["src", "data-src", "data-lazy-src", "href"].some((k) => CAPTCHA_SCRIPT_SRC_RE.test(a.get(k) || ""));
}

/**
 * Describe every contact form on a page. PURE: reads `html` only.
 *
 * A form is reported when it has a message field (a textarea, or a text field
 * named/labelled like a message) and is neither a search form nor a login form
 * (password field). Whether it also has an e-mail field is reported and feeds
 * the skip reason. `messageLength` (optional) is the length of the exact
 * message the lane would send; it only feeds `skipReason`. A NaN, infinite
 * or negative `messageLength` throws a RangeError (review N3).
 */
export function detectContactForms(
  html: string,
  pageUrl: string,
  producerWebsite: string,
  messageLength = 0,
): ContactFormSurvey {
  checkMessageLength(messageLength);
  const truncated = (html || "").length > CONTACT_FORM_MAX_HTML_CHARS;
  const src = truncated ? html.slice(0, CONTACT_FORM_MAX_HTML_CHARS) : html || "";
  const { tokens, unterminatedTag } = tokenize(src);
  // Fail closed (review r2 B1): when the page ends inside a tag, or was cut at
  // CONTACT_FORM_MAX_HTML_CHARS, markup we did not read (a formaction, a
  // `form=` button, a </form>) could change where a form posts, so no form
  // on the page counts as same-site.
  const untrustedTail = unterminatedTag || truncated;
  // Fail closed on markup this tokenizer does not model (review r3): foreign
  // content (<svg>/<math>: style, title, textarea, script are not raw text
  // there, and <base> may sit inside), a script that enters the
  // double-escaped state, nested <template>, a </form> the tree builder would
  // not honour, an ambiguous <base href>, form markup inside <noscript>.
  let untrustedMarkup = false;
  /** Open scope-boundary elements (table, object …) started inside the current form. */
  const boundaryOpen = new Map<string, number>();

  let baseUrl = pageUrl;
  let baseSeen = false;
  let pageCaptcha = false;
  let pageCharset: string | null = null;
  const rawForms: RawForm[] = [];
  const labelFor = new Map<string, string>();
  /**
   * Submit controls that name a form with `form="id"` (they may sit outside
   * it). Attached after the scan to the FIRST form with that id only, as a
   * browser does — so many forms sharing one id stay linear (review r2 B3).
   */
  const submittersByFormId = new Map<string, Attrs[]>();

  let form: RawForm | null = null;
  // Open <label> without `for`: text so far and the fields inside it.
  let label: { text: string; fields: RawField[]; forId: string | null } | null = null;

  for (const t of tokens) {
    if (t.kind === "text") {
      if (t.tag === "script") {
        if (CAPTCHA_INLINE_RE.test(t.text)) pageCaptcha = true;
        // "<!--" then "<script" + space,/,> enters script-data-double-escaped:
        // the browser does NOT end the script at the "</script>" we stopped at.
        const esc = t.text.indexOf("<!--");
        if (esc >= 0 && /<script[\t\n\f\r />]/i.test(t.text.slice(esc + 4))) untrustedMarkup = true;
        continue;
      }
      if (t.tag === "noscript" || t.tag === "template") {
        // Not parsed as forms here, but a captcha in a fallback still marks the page.
        if (CAPTCHA_INLINE_RE.test(t.text) || CAPTCHA_SCRIPT_SRC_RE.test(t.text)) pageCaptcha = true;
        if (t.tag === "noscript" && noscriptHasFormMarkup(t.text)) untrustedMarkup = true;
        // A nested <template> ends at ITS "</template>", not at the first one we stopped at.
        if (t.tag === "template" && /<template[\t\n\f\r />]/i.test(t.text)) untrustedMarkup = true;
        continue;
      }
      if (t.tag) continue; // style, textarea, title, xmp, iframe … content
      if (label) label.text += " " + t.text;
      continue;
    }
    const a = t.attrs;
    if (t.kind === "close") {
      if (t.tag === "label" && label) {
        const text = cleanText(label.text);
        if (label.forId) labelFor.set(label.forId, text);
        for (const f of label.fields) f.labelText = `${f.labelText} ${text}`.trim();
        label = null;
      } else if (t.tag === "form" && form) {
        // A boundary element opened inside the form and still open: the
        // browser ignores this </form> (form not in scope) and later controls
        // still belong to the form — fail closed.
        for (const v of boundaryOpen.values()) if (v > 0) untrustedMarkup = true;
        rawForms.push(form);
        form = null;
      } else if (form && FORM_SCOPE_BOUNDARY.has(t.tag)) {
        const v = boundaryOpen.get(t.tag) ?? 0;
        if (v > 0) boundaryOpen.set(t.tag, v - 1);
        if (t.tag === "table") for (const k of ["td", "th", "caption"]) boundaryOpen.set(k, 0); // </table> closes its cells
      }
      continue;
    }

    // open tag
    if (t.tag === "svg" || t.tag === "math") untrustedMarkup = true; // foreign content (review r3 B2)
    if (form && FORM_SCOPE_BOUNDARY.has(t.tag)) boundaryOpen.set(t.tag, (boundaryOpen.get(t.tag) ?? 0) + 1);
    const cls = a.get("class") || "";
    const markerCaptcha =
      CAPTCHA_CLASS_RE.test(cls) ||
      a.has("data-sitekey") ||
      CAPTCHA_NAME_RE.test(a.get("id") || "") ||
      CAPTCHA_TAG_RE.test(t.tag);
    switch (t.tag) {
      case "base":
        // Only the FIRST <base href> sets the document base, as in browsers (review r2 B1).
        if (a.has("href") && !baseSeen) {
          baseSeen = true;
          const href = urlAttr(a, "href");
          if (href === null) untrustedMarkup = true; // unknown base: every relative action is unknown (review r3 B3)
          else {
            try {
              baseUrl = new URL(href ?? "", pageUrl).toString(); // the URL parser strips what HTML strips
            } catch {
              /* keep page URL */
            }
          }
        }
        continue;
      case "meta": {
        const cs = a.get("charset") || (/charset=([^\s;"']+)/i.exec(a.get("content") || "")?.[1] ?? "");
        if (cs && !pageCharset) pageCharset = cs.toLowerCase();
        continue;
      }
      case "script":
      case "link":
        if (captchaUrl(a) || markerCaptcha) pageCaptcha = true;
        continue;
      case "iframe":
      case "img":
        if (captchaUrl(a) || markerCaptcha) {
          if (form) form.captcha = true;
          else pageCaptcha = true;
        }
        continue;
      case "form":
        if (form) continue; // nested <form> is ignored by HTML parsers
        boundaryOpen.clear();
        form = {
          attrs: a,
          fields: [],
          submitters: [],
          captcha: markerCaptcha,
          search: (a.get("role") || "").toLowerCase() === "search",
        };
        continue;
      case "label":
        label = { text: "", fields: [], forId: a.get("for") || null };
        continue;
    }
    if (markerCaptcha) {
      if (form) form.captcha = true;
      else pageCaptcha = true;
    }

    // Submit controls (review B1, r3 B4): see isSubmitControl(). Their
    // formaction / formmethod override the form's.
    const inputType = t.tag === "input" ? inputTypeOf(a) : "";
    if (isSubmitControl(t.tag, a)) {
      // `form="…"` is matched EXACTLY against ids, no trimming (review r3 B5).
      const owner = a.get("form");
      if (owner) {
        const list = submittersByFormId.get(owner) ?? [];
        list.push(a);
        submittersByFormId.set(owner, list);
      }
      if (form) form.submitters.push(a);
    }

    if (!form) continue;
    if (t.tag !== "input" && t.tag !== "textarea" && t.tag !== "select") {
      if ((a.get("role") || "").toLowerCase() === "search") form.search = true;
      continue;
    }
    const type = t.tag === "input" ? inputType : t.tag;
    if (["submit", "button", "reset", "image"].includes(type)) continue;
    const field: RawField = { type, attrs: a, labelText: "" };
    form.fields.push(field);
    if (CAPTCHA_NAME_RE.test(a.get("name") || "")) form.captcha = true;
    if (type === "search") form.search = true;
    if (label && !label.forId) label.fields.push(field);
    else if (label && label.forId && label.forId === a.get("id")) label.fields.push(field);
  }
  if (form) rawForms.push(form); // unclosed form runs to end of document

  const pageHost = (() => {
    try {
      return normalizeHost(new URL(pageUrl).hostname);
    } catch {
      return null;
    }
  })();
  const producerDomain = producerOwnHost(producerWebsite);
  const pageSameSite = !untrustedTail && !untrustedMarkup && urlIsOnProducerHost(pageUrl, producerDomain);

  /** rawForms index of the first form with each id (review r2 B3). */
  const firstFormById = new Map<string, number>();
  rawForms.forEach((rf, idx) => {
    const id = rf.attrs.get("id"); // exact, no trimming (review r3 B5)
    if (id && !firstFormById.has(id)) firstFormById.set(id, idx);
  });

  /**
   * An action attribute resolved as a browser does: absent or EXACTLY empty →
   * the document URL, else (whitespace included, not trimmed) against <base>.
   * null (ambiguous character reference) stays null: unknown destination.
   */
  const resolveAction = (raw: string | undefined | null): string | null => {
    if (raw === null) return null;
    try {
      return raw ? new URL(raw, baseUrl).toString() : new URL(pageUrl).toString();
    } catch {
      return null;
    }
  };
  /** ASCII lower case, no trimming (review r3 N4); any other value is GET. */
  const parseMethod = (raw: string): "get" | "post" | "dialog" => {
    const m = asciiLower(raw);
    return m === "post" ? "post" : m === "dialog" ? "dialog" : "get";
  };

  const forms: DetectedContactForm[] = [];
  rawForms.forEach((rf, index) => {
    const fields: ContactFormField[] = rf.fields.map((f) => {
      const id = f.attrs.get("id");
      const forText = id ? labelFor.get(id) ?? "" : "";
      const labelText = cleanText(`${f.labelText} ${forText}`);
      const role = classify(f.type, f.attrs, labelText);
      const shown = cleanText(
        [labelText, f.attrs.get("placeholder"), f.attrs.get("aria-label")].filter((v): v is string => !!v).join(" "),
      );
      return {
        name: f.attrs.get("name") ?? null,
        type: f.type,
        required: f.type === "hidden" ? false : isRequired(f.attrs, labelText),
        maxLength: parseMaxLength(f.attrs.get("maxlength")),
        role,
        label: shown,
      };
    });

    const textNames = rf.fields.filter((f) => f.type === "text").map((f) => (f.attrs.get("name") || "").toLowerCase());
    const looksLikeSearch =
      rf.search ||
      (!fields.some((f) => f.type === "textarea") &&
        textNames.length === 1 &&
        ["q", "s", "query", "search", "sok", "søk", "keyword", "keywords"].includes(textNames[0]!));
    if (looksLikeSearch) return;
    if (fields.some((f) => f.type === "password")) return;
    // Prefer a <textarea>: a single-line input drops line breaks (review N1).
    const messages = fields.filter((f) => f.role === "message");
    const message = messages.find((f) => f.type === "textarea") ?? messages[0] ?? null;
    if (!message) return;

    const action = resolveAction(urlAttr(rf.attrs, "action"));
    const method = parseMethod(rf.attrs.get("method") || "get");
    const ac = (rf.attrs.get("accept-charset") || "").trim().split(/[\s,]+/)[0] || "";

    const formId = rf.attrs.get("id") || "";
    const byId = formId && firstFormById.get(formId) === index ? submittersByFormId.get(formId) ?? [] : [];
    const submitters = [...rf.submitters, ...byId];
    const submitActions: ContactFormSubmitAction[] = [];
    for (const s of new Set(submitters)) {
      const hasAction = s.has("formaction");
      const hasMethod = s.has("formmethod");
      if (!hasAction && !hasMethod) continue;
      submitActions.push({
        action: hasAction ? resolveAction(urlAttr(s, "formaction")) : action,
        method: hasMethod ? parseMethod(s.get("formmethod") || "") : null,
      });
    }

    const detected: DetectedContactForm = {
      index,
      action,
      method,
      acceptCharset: ac ? ac.toLowerCase() : null,
      fields,
      submitActions,
      captcha: pageCaptcha || rf.captcha,
      sameSiteAsProducer:
        pageSameSite &&
        urlIsOnProducerHost(action, producerDomain) &&
        submitActions.every((s) => urlIsOnProducerHost(s.action, producerDomain)),
      messageMaxLength: message.maxLength,
      phoneRequired: fields.some((f) => f.role === "phone" && f.required),
      hasMessageField: true,
      hasEmailField: fields.some((f) => f.role === "email"),
      unfillableRequired: fields
        .filter((f) => f.required && (f.role === "other" || f.role === "optional_checkbox"))
        .map((f) => f.name || f.label || f.type),
      skipReason: null,
    };
    detected.skipReason = formSkipReason(detected, messageLength);
    forms.push(detected);
  });

  return {
    pageUrl,
    pageHost,
    producerDomain,
    pageCaptcha,
    pageCharset,
    formsTotal: rawForms.length,
    forms,
  };
}

/**
 * Why a submission lane must skip this form, or null. PURE.
 *
 * `messageLength` is the length of the exact message that would be sent (count
 * CRLF line breaks as two, to be safe). A message longer than the field's
 * maxlength is skipped (`melding_for_lang`) — it is never truncated. A NaN,
 * infinite or negative `messageLength` throws a RangeError (review N3).
 */
export function formSkipReason(
  form: Pick<DetectedContactForm, "captcha" | "sameSiteAsProducer" | "phoneRequired" | "messageMaxLength" | "fields"> &
    Partial<Pick<DetectedContactForm, "hasMessageField" | "hasEmailField" | "method" | "submitActions">>,
  messageLength: number,
): ContactFormSkipReason | null {
  checkMessageLength(messageLength);
  if (form.captcha) return "captcha";
  if (!form.sameSiteAsProducer) return "annet_domene";
  // method=dialog (on the form or a submit control's formmethod) closes a
  // <dialog> and sends nothing (review N4).
  if (form.method === "dialog" || (form.submitActions ?? []).some((s) => s.method === "dialog")) return "metode_dialog";
  const hasMessage = form.hasMessageField ?? form.fields.some((f) => f.role === "message");
  if (!hasMessage) return "mangler_meldingsfelt";
  const hasEmail = form.hasEmailField ?? form.fields.some((f) => f.role === "email");
  if (!hasEmail) return "mangler_epostfelt";
  if (form.phoneRequired) return "telefon_paakrevd";
  if (form.messageMaxLength !== null && messageLength > form.messageMaxLength) return "melding_for_lang";
  return null;
}
