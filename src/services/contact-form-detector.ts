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
// small linear tokenizer (tags + text, comments/script/style handled). It is
// deliberately conservative: anything it is unsure about makes a form MORE
// likely to be skipped (captcha anywhere on the page, a "*" in a label =
// required, an unknown producer domain = not same-site), never less.

import { isHostedPlatformHost, normalizeHost, registrableDomain, websiteHost } from "./claim-domain-rule";

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

export interface DetectedContactForm {
  /** 0-based position among ALL <form> elements on the page. */
  index: number;
  /** Absolute action URL (the page URL, or <base href>, when absent/empty). */
  action: string | null;
  method: "get" | "post" | "dialog";
  /** First token of accept-charset, lower case, or null. */
  acceptCharset: string | null;
  fields: ContactFormField[];
  captcha: boolean;
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
  /** The producer's registrable domain, or null (missing/unparseable/hosted platform). */
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
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!.toLowerCase();
    if (attrs.has(key)) continue; // first wins, as in HTML
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs.set(key, decodeEntities(val));
  }
  return attrs;
}

/** Linear tokenizer. Comments are dropped; script/style bodies are one text token. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  // Tag alternatives start with distinct characters, so the attribute part
  // cannot backtrack catastrophically.
  const re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) tokens.push({ kind: "text", tag: "", attrs: new Map(), text: html.slice(last, m.index) });
    last = re.lastIndex;
    if (m[2] === undefined) continue; // comment
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      tokens.push({ kind: "close", tag, attrs: new Map(), text: "" });
      continue;
    }
    tokens.push({ kind: "open", tag, attrs: parseAttrs(m[3] ?? ""), text: "" });
    if (tag === "script" || tag === "style" || tag === "textarea") {
      // Raw-text content up to the matching close tag.
      const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
      closeRe.lastIndex = last;
      const c = closeRe.exec(html);
      const end = c ? c.index : html.length;
      if (end > last) tokens.push({ kind: "text", tag, attrs: new Map(), text: html.slice(last, end) });
      if (c) tokens.push({ kind: "close", tag, attrs: new Map(), text: "" });
      last = c ? closeRe.lastIndex : html.length;
      re.lastIndex = last;
    }
  }
  if (last < html.length) tokens.push({ kind: "text", tag: "", attrs: new Map(), text: html.slice(last) });
  return tokens;
}

// ── Classification ──────────────────────────────────────────────────────────

const CAPTCHA_NAME_RE = /captcha|g-recaptcha|h-captcha|cf-turnstile|frc-/i;
const CAPTCHA_CLASS_RE = /(?:^|\s)(?:g-recaptcha|h-captcha|cf-turnstile|frc-captcha|[\w-]*captcha[\w-]*)(?:\s|$)/i;
const CAPTCHA_SCRIPT_SRC_RE = /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com\/turnstile|friendlycaptcha|frc-captcha|captcha/i;
const CAPTCHA_INLINE_RE = /grecaptcha|hcaptcha|turnstile\.render|friendlychallenge|data-sitekey/i;

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

function parseMaxLength(a: Attrs): number | null {
  const v = (a.get("maxlength") || "").trim();
  if (!/^\d{1,9}$/.test(v)) return null;
  return parseInt(v, 10);
}

function cleanText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function stripWww(host: string): string {
  return host.startsWith("www.") && host.split(".").length > 2 ? host.slice(4) : host;
}

/** The producer's own registrable domain, or null (unparseable or a hosted platform). */
export function producerRegistrableDomain(producerWebsite: string): string | null {
  const host = websiteHost(producerWebsite);
  if (!host || isHostedPlatformHost(host)) return null;
  return registrableDomain(stripWww(host));
}

/** Does `url` (http/https) live on `domain` or a subdomain of it? PURE. */
export function urlIsOnDomain(url: string | null, domain: string | null): boolean {
  if (!url || !domain) return false;
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
  return host === domain || host.endsWith(`.${domain}`);
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
  captcha: boolean;
  search: boolean;
}

/**
 * Describe every contact form on a page. PURE: reads `html` only.
 *
 * A form is reported when it has a message field (a textarea, or a text field
 * named/labelled like a message) and is neither a search form nor a login form
 * (password field). Whether it also has an e-mail field is reported and feeds
 * the skip reason. `messageLength` (optional) is the length of the exact
 * message the lane would send; it only feeds `skipReason`.
 */
export function detectContactForms(
  html: string,
  pageUrl: string,
  producerWebsite: string,
  messageLength = 0,
): ContactFormSurvey {
  const src = (html || "").length > CONTACT_FORM_MAX_HTML_CHARS ? html.slice(0, CONTACT_FORM_MAX_HTML_CHARS) : html || "";
  const tokens = tokenize(src);

  let baseUrl = pageUrl;
  let pageCaptcha = false;
  let pageCharset: string | null = null;
  const rawForms: RawForm[] = [];
  const labelFor = new Map<string, string>();

  let form: RawForm | null = null;
  // Open <label> without `for`: text so far and the fields inside it.
  let label: { text: string; fields: RawField[]; forId: string | null } | null = null;
  let inScript = false;
  let inTextarea: RawField | null = null;

  for (const t of tokens) {
    if (t.kind === "text") {
      if (t.tag === "script" || inScript) {
        if (CAPTCHA_INLINE_RE.test(t.text)) pageCaptcha = true;
        continue;
      }
      if (t.tag === "style" || inTextarea) continue;
      if (label) label.text += " " + t.text;
      continue;
    }
    const a = t.attrs;
    if (t.kind === "close") {
      if (t.tag === "script") inScript = false;
      else if (t.tag === "textarea") inTextarea = null;
      else if (t.tag === "label" && label) {
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
      CAPTCHA_CLASS_RE.test(cls) || a.has("data-sitekey") || CAPTCHA_NAME_RE.test(a.get("id") || "");
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
        inScript = true;
        if (CAPTCHA_SCRIPT_SRC_RE.test(a.get("src") || "")) pageCaptcha = true;
        continue;
      case "iframe":
        if (CAPTCHA_SCRIPT_SRC_RE.test(a.get("src") || "")) {
          if (form) form.captcha = true;
          else pageCaptcha = true;
        }
        continue;
      case "form":
        if (form) continue; // nested <form> is ignored by HTML parsers
        form = {
          attrs: a,
          fields: [],
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
    if (!form) continue;
    if (t.tag !== "input" && t.tag !== "textarea" && t.tag !== "select") {
      if ((a.get("role") || "").toLowerCase() === "search") form.search = true;
      continue;
    }
    const type = t.tag === "input" ? (a.get("type") || "text").trim().toLowerCase() : t.tag;
    if (["submit", "button", "reset", "image"].includes(type)) continue;
    const field: RawField = { type, attrs: a, labelText: "" };
    form.fields.push(field);
    if (CAPTCHA_NAME_RE.test(a.get("name") || "")) form.captcha = true;
    if (type === "search") form.search = true;
    if (label && !label.forId) label.fields.push(field);
    else if (label && label.forId && label.forId === a.get("id")) label.fields.push(field);
    if (t.tag === "textarea") inTextarea = field;
  }
  if (form) rawForms.push(form); // unclosed form runs to end of document

  const pageHost = (() => {
    try {
      return normalizeHost(new URL(pageUrl).hostname);
    } catch {
      return null;
    }
  })();
  const producerDomain = producerRegistrableDomain(producerWebsite);
  const pageSameSite = urlIsOnDomain(pageUrl, producerDomain);

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
        maxLength: parseMaxLength(f.attrs),
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
    const message = fields.find((f) => f.role === "message") ?? null;
    if (!message) return;

    const rawAction = (rf.attrs.get("action") || "").trim();
    let action: string | null;
    try {
      action = new URL(rawAction || baseUrl, baseUrl).toString();
    } catch {
      action = null;
    }
    const m = (rf.attrs.get("method") || "get").trim().toLowerCase();
    const method: DetectedContactForm["method"] = m === "post" ? "post" : m === "dialog" ? "dialog" : "get";
    const ac = (rf.attrs.get("accept-charset") || "").trim().split(/[\s,]+/)[0] || "";

    const detected: DetectedContactForm = {
      index,
      action,
      method,
      acceptCharset: ac ? ac.toLowerCase() : null,
      fields,
      captcha: pageCaptcha || rf.captcha,
      sameSiteAsProducer: pageSameSite && urlIsOnDomain(action, producerDomain),
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
 * maxlength is skipped (`melding_for_lang`) — it is never truncated.
 */
export function formSkipReason(
  form: Pick<DetectedContactForm, "captcha" | "sameSiteAsProducer" | "phoneRequired" | "messageMaxLength" | "fields"> &
    Partial<Pick<DetectedContactForm, "hasMessageField" | "hasEmailField">>,
  messageLength: number,
): ContactFormSkipReason | null {
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
