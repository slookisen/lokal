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
// elsewhere = not same-site), never less.
//
// "Same site" means the producer's OWN host (leading "www." stripped) or a
// subdomain of it — never a sibling, a parent, or anything else that merely
// shares a registrable domain or hosting suffix (review B2, 2026-11-05).

import { isHostedPlatformHost, normalizeHost, registrableDomain, stripWww, websiteHost } from "./claim-domain-rule";

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
  | "mangler_epostfelt";

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

type Attrs = Map<string, string>;

interface Token {
  kind: "open" | "close" | "text";
  /** Tag name; for a text token the raw-text element it sits in ("script", "title" …), else "". */
  tag: string;
  attrs: Attrs;
  text: string;
}

const ENTITY: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aelig: "æ", oslash: "ø", aring: "å", AElig: "Æ", Oslash: "Ø", Aring: "Å",
  laquo: "«", raquo: "»", mdash: "—", ndash: "–",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return Object.prototype.hasOwnProperty.call(ENTITY, body) ? ENTITY[body]! : m;
  });
}

function parseAttrs(raw: string): Attrs {
  const attrs: Attrs = new Map();
  // Quotes only delimit a value right after "="; an unquoted value runs to
  // whitespace, so `alt=Ola's` is one value (review N8), as in browsers.
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!.toLowerCase();
    if (attrs.has(key)) continue; // first wins, as in HTML
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs.set(key, decodeEntities(val));
  }
  return attrs;
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

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

/**
 * Tokenize `html` into open/close tags and text. Comments are dropped;
 * raw-text element bodies are one text token.
 *
 * Linear time (review B3): the old single regex rescanned the rest of the
 * input for every "<" that had no ">", so `"<a".repeat(n)` was quadratic.
 * Here a tag ends at the first ">" outside a quoted attribute value; an
 * unquoted "<" inside a tag makes that "<" plain text (conservative — a
 * browser would keep going). Each scan position is marked in `seen` per
 * state; a scan only revisits a position after an earlier scan through it
 * FAILED (a successful scan moves the cursor past its ">"), and a scan that
 * reaches a failed position stops there, so every character is scanned
 * O(1) times. Quoted values are skipped with indexOf; consecutive quotes of
 * one kind bound disjoint intervals, so that is linear too.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const n = html.length;
  const seen = new Uint8Array(n + 1); // bit 1: between attributes, bit 2: in an unquoted value
  const nameRe = /[a-zA-Z][a-zA-Z0-9:-]*/y;

  /** Index of the ">" that ends a tag whose name ends at `p`, or -1. */
  function tagEnd(p: number): number {
    let inValue = false;
    while (p < n) {
      const bit = inValue ? 2 : 1;
      if (seen[p]! & bit) return -1; // an earlier scan from here failed
      seen[p]! |= bit;
      const c = html.charCodeAt(p);
      if (c === 62 /* > */) return p;
      if (c === 60 /* < */) return -1;
      if (inValue) {
        if (isWs(c)) inValue = false;
        p++;
        continue;
      }
      if (c !== 61 /* = */) {
        p++;
        continue;
      }
      let j = p + 1;
      while (j < n && isWs(html.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = html.charCodeAt(j);
      if (q === 34 /* " */ || q === 39 /* ' */) {
        const close = html.indexOf(q === 34 ? '"' : "'", j + 1);
        if (close < 0) return -1;
        p = close + 1;
      } else {
        inValue = true;
        p = j;
      }
    }
    return -1;
  }

  let i = 0;
  let textStart = 0;
  const pushText = (end: number, tag = ""): void => {
    if (end > textStart) tokens.push({ kind: "text", tag, attrs: new Map(), text: html.slice(textStart, end) });
  };

  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      pushText(lt);
      let end: number;
      if (html.startsWith("<!-->", lt)) end = lt + 5;
      else if (html.startsWith("<!--->", lt)) end = lt + 6;
      else {
        const c = html.indexOf("-->", lt + 4);
        end = c < 0 ? n : c + 3; // an unclosed comment runs to the end
      }
      i = textStart = end;
      continue;
    }
    const isClose = html.charCodeAt(lt + 1) === 47; /* / */
    nameRe.lastIndex = lt + (isClose ? 2 : 1);
    const nm = nameRe.exec(html);
    if (!nm) {
      i = lt + 1;
      continue;
    }
    const nameEnd = nameRe.lastIndex;
    const gt = tagEnd(nameEnd);
    if (gt < 0) {
      i = lt + 1; // not a tag: the "<" is text
      continue;
    }
    pushText(lt);
    const tag = nm[0].toLowerCase();
    i = textStart = gt + 1;
    if (isClose) {
      tokens.push({ kind: "close", tag, attrs: new Map(), text: "" });
      continue;
    }
    tokens.push({ kind: "open", tag, attrs: parseAttrs(html.slice(nameEnd, gt)), text: "" });
    if (RAW_TEXT_TAGS.has(tag)) {
      // Content up to "</tag" followed by whitespace, "/" or ">", then the next ">".
      const closeRe = new RegExp(`</${tag}(?=[\\s/>])`, "gi");
      closeRe.lastIndex = i;
      const c = closeRe.exec(html);
      const closeGt = c ? html.indexOf(">", c.index + 2 + tag.length) : -1;
      if (!c || closeGt < 0) {
        pushText(n, tag); // unclosed: the rest of the document is its content
        i = textStart = n;
        break;
      }
      pushText(c.index, tag);
      tokens.push({ kind: "close", tag, attrs: new Map(), text: "" });
      i = textStart = closeGt + 1;
    }
  }
  pushText(n);
  return tokens;
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
 * site — isHostedPlatformHost, as in claim-domain-rule), or a bare public
 * suffix such as "co.uk".
 */
export function producerOwnHost(producerWebsite: string): string | null {
  const host = websiteHost(producerWebsite);
  if (!host || isHostedPlatformHost(host)) return null;
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
  const src = (html || "").length > CONTACT_FORM_MAX_HTML_CHARS ? html.slice(0, CONTACT_FORM_MAX_HTML_CHARS) : html || "";
  const tokens = tokenize(src);

  let baseUrl = pageUrl;
  let pageCaptcha = false;
  let pageCharset: string | null = null;
  const rawForms: RawForm[] = [];
  const labelFor = new Map<string, string>();
  /** Submit controls that name a form with `form="id"` (they may sit outside it). */
  const submittersByFormId = new Map<string, Attrs[]>();

  let form: RawForm | null = null;
  // Open <label> without `for`: text so far and the fields inside it.
  let label: { text: string; fields: RawField[]; forId: string | null } | null = null;

  for (const t of tokens) {
    if (t.kind === "text") {
      if (t.tag === "script") {
        if (CAPTCHA_INLINE_RE.test(t.text)) pageCaptcha = true;
        continue;
      }
      if (t.tag === "noscript" || t.tag === "template") {
        // Not parsed as forms here, but a captcha in a fallback still marks the page.
        if (CAPTCHA_INLINE_RE.test(t.text) || CAPTCHA_SCRIPT_SRC_RE.test(t.text)) pageCaptcha = true;
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
        rawForms.push(form);
        form = null;
      }
      continue;
    }

    // open tag
    const cls = a.get("class") || "";
    const markerCaptcha =
      CAPTCHA_CLASS_RE.test(cls) ||
      a.has("data-sitekey") ||
      CAPTCHA_NAME_RE.test(a.get("id") || "") ||
      CAPTCHA_TAG_RE.test(t.tag);
    switch (t.tag) {
      case "base":
        if (a.get("href")) {
          try {
            baseUrl = new URL(a.get("href")!, pageUrl).toString();
          } catch {
            /* keep page URL */
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

    // Submit controls (review B1): <button> is a submit button unless
    // type=button|reset; <input type=submit|image> too. Their formaction /
    // formmethod override the form's.
    const inputType = t.tag === "input" ? (a.get("type") || "text").trim().toLowerCase() : "";
    const isSubmitter =
      (t.tag === "button" && !["button", "reset"].includes((a.get("type") || "submit").trim().toLowerCase())) ||
      (t.tag === "input" && (inputType === "submit" || inputType === "image"));
    if (isSubmitter) {
      const owner = (a.get("form") || "").trim();
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
  const pageSameSite = urlIsOnProducerHost(pageUrl, producerDomain);

  /** An action attribute resolved as a browser does: empty → the document URL, else against <base>. */
  const resolveAction = (raw: string): string | null => {
    try {
      return raw ? new URL(raw, baseUrl).toString() : new URL(pageUrl).toString();
    } catch {
      return null;
    }
  };
  const parseMethod = (raw: string): "get" | "post" | "dialog" => {
    const m = raw.trim().toLowerCase();
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

    const action = resolveAction((rf.attrs.get("action") || "").trim());
    const method = parseMethod(rf.attrs.get("method") || "get");
    const ac = (rf.attrs.get("accept-charset") || "").trim().split(/[\s,]+/)[0] || "";

    const formId = (rf.attrs.get("id") || "").trim();
    const submitters = [...rf.submitters, ...(formId ? submittersByFormId.get(formId) ?? [] : [])];
    const submitActions: ContactFormSubmitAction[] = [];
    for (const s of new Set(submitters)) {
      const hasAction = s.has("formaction");
      const hasMethod = s.has("formmethod");
      if (!hasAction && !hasMethod) continue;
      submitActions.push({
        action: hasAction ? resolveAction((s.get("formaction") || "").trim()) : action,
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
    Partial<Pick<DetectedContactForm, "hasMessageField" | "hasEmailField">>,
  messageLength: number,
): ContactFormSkipReason | null {
  checkMessageLength(messageLength);
  if (form.captcha) return "captcha";
  if (!form.sameSiteAsProducer) return "annet_domene";
  const hasMessage = form.hasMessageField ?? form.fields.some((f) => f.role === "message");
  if (!hasMessage) return "mangler_meldingsfelt";
  const hasEmail = form.hasEmailField ?? form.fields.some((f) => f.role === "email");
  if (!hasEmail) return "mangler_epostfelt";
  if (form.phoneRequired) return "telefon_paakrevd";
  if (form.messageMaxLength !== null && messageLength > form.messageMaxLength) return "melding_for_lang";
  return null;
}
