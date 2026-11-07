/**
 * contact-form-detector.test.ts — pure unit tests for dev-request
 * 2026-10-03-rfb-kontaktskjema-henvendelser, slice 1: the offline contact-form
 * detector and its skip reasons (services/contact-form-detector.ts). No
 * network, no DB, nothing submitted. The robots.txt case uses the existing
 * pure parser in services/product-import/robots.ts on a form action URL.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/contact-form-detector.test.ts
 *   2. Wired into the gate: tests/test.ts imports runContactFormDetectorTests().
 */

import {
  detectContactForms,
  formSkipReason,
  producerOwnHost,
  urlIsOnProducerHost,
  parseMaxLength,
  decodeEntities,
  CONTACT_FORM_MAX_HTML_CHARS,
  type ContactFormField,
  type DetectedContactForm,
} from "./contact-form-detector";
import { parseRobotsTxt, isPathAllowed } from "./product-import/robots";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PAGE = "https://www.gard.no/kontakt";
const SITE = "https://www.gard.no";

function page(body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

const PLAIN_FORM = `
<form action="/send" method="POST" accept-charset="UTF-8">
  <label for="f-navn">Navn *</label><input id="f-navn" name="navn" type="text" required>
  <label for="f-epost">E-post *</label><input id="f-epost" name="epost" type="email" required>
  <label for="f-tlf">Telefon</label><input id="f-tlf" name="telefon" type="tel">
  <label for="f-emne">Emne</label><input id="f-emne" name="emne" type="text">
  <label for="f-firma">Firma</label><input id="f-firma" name="firma" type="text">
  <label for="f-melding">Melding *</label><textarea id="f-melding" name="melding" required>forhåndstekst <b>ikke label</b></textarea>
  <input type="hidden" name="_token" value="abc">
  <label><input type="checkbox" name="samtykke" required> Jeg godtar at opplysningene mine lagres</label>
  <label><input type="checkbox" name="nyhetsbrev"> Ja, send meg nyhetsbrev</label>
  <button type="submit">Send</button>
</form>`;

export function runContactFormDetectorTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function roleOf(form: DetectedContactForm | undefined, name: string): string | null {
    return form?.fields.find((f) => f.name === name)?.role ?? null;
  }
  function only(html: string, pageUrl = PAGE, site = SITE, len = 0): DetectedContactForm | undefined {
    const s = detectContactForms(html, pageUrl, site, len);
    return s.forms.length === 1 ? s.forms[0] : undefined;
  }

  // 1. Plain same-domain contact form with Norwegian names/labels: no skip.
  {
    const s = detectContactForms(page(PLAIN_FORM), PAGE, SITE, 600);
    const f = s.forms[0];
    assertEq(s.formsTotal, 1, "plain: one form on the page");
    assertEq(s.forms.length, 1, "plain: detected as contact form");
    assertEq(s.producerDomain, "gard.no", "plain: producer domain strips www.");
    assertEq(s.pageCharset, "utf-8", "plain: page charset read from <meta charset>");
    assertEq(f?.action, "https://www.gard.no/send", "plain: relative action resolved against page URL");
    assertEq(f?.method, "post", "plain: method lower-cased");
    assertEq(f?.acceptCharset, "utf-8", "plain: accept-charset");
    assertEq(f?.captcha, false, "plain: no captcha");
    assertEq(f?.sameSiteAsProducer, true, "plain: same site");
    assertEq(f?.phoneRequired, false, "plain: phone optional");
    assertEq(f?.messageMaxLength, null, "plain: no maxlength");
    assertEq(f?.skipReason, null, "plain: no skip reason");
    assertEq(
      f?.fields.map((x) => `${x.name}:${x.role}`),
      [
        "navn:name",
        "epost:email",
        "telefon:phone",
        "emne:subject",
        "firma:company",
        "melding:message",
        "_token:hidden",
        "samtykke:consent_required_own_data",
        "nyhetsbrev:optional_checkbox",
      ],
      "plain: Norwegian field roles (navn, e-post, telefon, emne, firma, melding) + hidden + checkboxes",
    );
    assertEq(f?.fields.find((x) => x.name === "navn")?.required, true, "plain: required attr read");
    assertEq(f?.fields.find((x) => x.name === "melding")?.label, "Melding *", "plain: textarea content is not label text");
    assertEq(f?.unfillableRequired, [], "plain: nothing required that rules cannot fill");
  }

  // 2. Consent vs newsletter checkbox.
  {
    const f = only(
      page(`<form method="post"><input name="name"><input name="email" type="email"><textarea name="message"></textarea>
        <input type="checkbox" id="c1" name="gdpr" required><label for="c1">I agree that my data is stored to answer my enquiry</label>
        <input type="checkbox" id="c2" name="consent-marketing"><label for="c2">Jeg samtykker til markedsføring</label>
        <input type="checkbox" id="c3" name="terms" required><label for="c3">Jeg har lest vilkårene</label></form>`),
    );
    assertEq(roleOf(f, "gdpr"), "consent_required_own_data", "consent: required own-data box");
    assertEq(roleOf(f, "consent-marketing"), "optional_checkbox", "consent: marketing box is optional even if it says samtykke");
    assertEq(roleOf(f, "terms"), "other", "consent: required terms box is not own-data consent");
    assertEq(f?.unfillableRequired, ["terms"], "consent: required non-consent box is reported as unfillable");
    assertEq(f?.method, "post", "consent: method post");
    assertEq(f?.action, PAGE, "consent: missing action = page URL");
  }

  // 3. reCAPTCHA (widget in form, and v3 script elsewhere on the page).
  {
    const f1 = only(page(PLAIN_FORM.replace("<button", '<div class="g-recaptcha" data-sitekey="x"></div><button')));
    assertEq(f1?.captcha, true, "recaptcha: widget in form → captcha");
    assertEq(f1?.skipReason, "captcha", "recaptcha: skip reason");
    const f2 = only(page(PLAIN_FORM, '<script src="https://www.google.com/recaptcha/api.js?render=abc"></script>'));
    assertEq(f2?.skipReason, "captcha", "recaptcha v3: page script → captcha");
    const f3 = only(page(PLAIN_FORM + "<script>grecaptcha.ready(function(){})</script>"));
    assertEq(f3?.skipReason, "captcha", "recaptcha: inline grecaptcha → captcha");
    const f4 = only(page(PLAIN_FORM.replace("<button", '<input type="text" name="captcha_code"><button')));
    assertEq(f4?.skipReason, "captcha", "captcha-named field → captcha");
    assertEq(roleOf(f4, "captcha_code"), "other", "captcha-named field role other");
  }

  // 4. hCaptcha / Turnstile / Friendly Captcha.
  {
    const h = only(page(PLAIN_FORM.replace("<button", '<div class="h-captcha" data-sitekey="y"></div><button')));
    assertEq(h?.skipReason, "captcha", "hcaptcha widget → captcha");
    const h2 = only(page(PLAIN_FORM, '<script src="https://js.hcaptcha.com/1/api.js" async defer></script>'));
    assertEq(h2?.skipReason, "captcha", "hcaptcha script → captcha");
    const t = only(page(PLAIN_FORM.replace("<button", '<div class="cf-turnstile" data-sitekey="z"></div><button')));
    assertEq(t?.skipReason, "captcha", "turnstile widget → captcha");
    const t2 = only(page(PLAIN_FORM, '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'));
    assertEq(t2?.skipReason, "captcha", "turnstile script → captcha");
    const fr = only(page(PLAIN_FORM.replace("<button", '<div class="frc-captcha" data-sitekey="w"></div><button')));
    assertEq(fr?.skipReason, "captcha", "friendly captcha widget → captcha");
  }

  // 5. Action on another domain / third-party host / platform site.
  {
    const other = PLAIN_FORM.replace('action="/send"', 'action="https://forms.formhost.example.com/f/123"');
    assertEq(only(page(other))?.sameSiteAsProducer, false, "annet_domene: third-party action host");
    assertEq(only(page(other))?.skipReason, "annet_domene", "annet_domene: skip reason");
    const fb = PLAIN_FORM.replace('action="/send"', 'action="https://www.facebook.com/msg"');
    assertEq(only(page(fb))?.skipReason, "annet_domene", "annet_domene: facebook action");
    // The page itself is not on the producer's domain (shop platform page).
    assertEq(
      only(page(PLAIN_FORM), "https://shop.example-platform.com/gard/kontakt")?.skipReason,
      "annet_domene",
      "annet_domene: page on another domain",
    );
    // The producer's "website" is a hosted platform: never same-site.
    assertEq(producerOwnHost("https://gard.wixsite.com/gard"), null, "platform website → no producer domain");
    assertEq(
      only(page(PLAIN_FORM), "https://gard.wixsite.com/gard/kontakt", "https://gard.wixsite.com/gard")?.skipReason,
      "annet_domene",
      "annet_domene: producer site on a hosted platform",
    );
    const lookalike = PLAIN_FORM.replace('action="/send"', 'action="https://gard.no.evil.example/send"');
    assertEq(only(page(lookalike))?.skipReason, "annet_domene", "annet_domene: look-alike host");
    const mailto = PLAIN_FORM.replace('action="/send"', 'action="mailto:post@gard.no"');
    assertEq(only(page(mailto))?.skipReason, "annet_domene", "annet_domene: mailto action is not an http form");
  }

  // 6. Subdomain of the producer domain = same site.
  {
    const sub = PLAIN_FORM.replace('action="/send"', 'action="https://skjema.gard.no/send"');
    assertEq(only(page(sub))?.sameSiteAsProducer, true, "subdomain action is same site");
    assertEq(only(page(PLAIN_FORM), "https://gard.no/kontakt", "gard.no")?.sameSiteAsProducer, true, "bare website value");
    assertEq(urlIsOnProducerHost("https://a.b.gard.no/x", "gard.no"), true, "urlIsOnProducerHost: deep subdomain");
    assertEq(urlIsOnProducerHost("https://ostegard.no/x", "gard.no"), false, "urlIsOnProducerHost: suffix without dot is not a subdomain");
  }

  // 7. Required phone.
  {
    const req = PLAIN_FORM.replace('name="telefon" type="tel"', 'name="telefon" type="tel" required');
    const f = only(page(req));
    assertEq(f?.phoneRequired, true, "telefon_paakrevd: required attr");
    assertEq(f?.skipReason, "telefon_paakrevd", "telefon_paakrevd: skip reason");
    const star = PLAIN_FORM.replace(">Telefon<", ">Telefon *<");
    assertEq(only(page(star))?.skipReason, "telefon_paakrevd", "telefon_paakrevd: '*' in label counts as required");
    const tlf = only(page(`<form><input name="tlf" aria-required="true"><input name="e-post"><textarea name="beskjed"></textarea></form>`));
    assertEq(tlf?.skipReason, "telefon_paakrevd", "telefon_paakrevd: tlf name + aria-required");
  }

  // 8. maxlength shorter than the message: skipped, never truncated.
  {
    const ml = PLAIN_FORM.replace('name="melding" required', 'name="melding" required maxlength="500"');
    const f = only(page(ml), PAGE, SITE, 800);
    assertEq(f?.messageMaxLength, 500, "melding_for_lang: maxlength read");
    assertEq(f?.skipReason, "melding_for_lang", "melding_for_lang: 800 > 500");
    assertEq(only(page(ml), PAGE, SITE, 500)?.skipReason, null, "melding_for_lang: equal length fits");
    if (f) {
      assertEq(formSkipReason(f, 501), "melding_for_lang", "formSkipReason: 501 > 500");
      assertEq(formSkipReason(f, 120), null, "formSkipReason: short message ok");
    }
  }

  // 9. formSkipReason on hand-built forms: missing fields, precedence.
  {
    const base: Pick<DetectedContactForm, "captcha" | "sameSiteAsProducer" | "phoneRequired" | "messageMaxLength" | "fields"> = {
      captcha: false,
      sameSiteAsProducer: true,
      phoneRequired: false,
      messageMaxLength: null,
      fields: [],
    };
    const fld = (role: ContactFormField["role"]): ContactFormField => ({
      name: role, type: "text", required: false, maxLength: null, role, label: "",
    });
    assertEq(formSkipReason({ ...base, fields: [fld("email")] }, 10), "mangler_meldingsfelt", "skip: no message field");
    assertEq(formSkipReason({ ...base, fields: [fld("message")] }, 10), "mangler_epostfelt", "skip: no email field");
    assertEq(
      formSkipReason({ ...base, captcha: true, sameSiteAsProducer: false, fields: [fld("message"), fld("email")] }, 10),
      "captcha",
      "skip: captcha wins over other reasons",
    );
    // Detector: textarea form without an e-mail field is still surveyed, skipped.
    const noMail = only(page(`<form action="/x" method="post"><input name="navn"><textarea name="melding"></textarea></form>`));
    assertEq(noMail?.hasEmailField, false, "survey: textarea-only form is reported");
    assertEq(noMail?.skipReason, "mangler_epostfelt", "survey: missing e-mail → mangler_epostfelt");
  }

  // 10. Search / login / newsletter-only forms are not contact forms.
  {
    const s = detectContactForms(
      page(`<form role="search" action="/sok"><input type="search" name="q"><button>Søk</button></form>
            <form action="/"><input type="text" name="s"></form>`),
      PAGE,
      SITE,
    );
    assertEq([s.formsTotal, s.forms.length], [2, 0], "search-only page: no contact form");
    const login = detectContactForms(
      page(`<form><input name="user"><input type="password" name="pw"><textarea name="message"></textarea></form>`),
      PAGE,
      SITE,
    );
    assertEq(login.forms.length, 0, "login form (password) is not a contact form");
    const news = detectContactForms(page(`<form><input type="email" name="email"><input name="navn"></form>`), PAGE, SITE);
    assertEq(news.forms.length, 0, "newsletter signup (no message field) is not a contact form");
    assertEq(detectContactForms("", PAGE, SITE).forms.length, 0, "empty HTML: nothing");
  }

  // 11. Relative action resolution, <base href>, method default, attribute quirks.
  {
    const f = only(page(`<form action="../skjema/send.php?x=1&amp;y=2"><input name=email type=email><textarea name=msg></textarea></form>`), "https://gard.no/om/kontakt/");
    assertEq(f?.action, "https://gard.no/om/skjema/send.php?x=1&y=2", "relative ../ action + entity-decoded");
    assertEq(f?.method, "get", "method defaults to get");
    assertEq(f?.acceptCharset, null, "no accept-charset → null");
    const b = only(page(`<form action="send"><input type="email" name="e"><textarea name="m"></textarea></form>`, '<base href="https://www.gard.no/nb/">'));
    assertEq(b?.action, "https://www.gard.no/nb/send", "<base href> is honoured");
    const bad = only(page(`<form method="PUT" action=""><input type="email" name="e"><textarea name="m" maxlength="abc"></textarea></form>`));
    assertEq([bad?.method, bad?.action, bad?.messageMaxLength], ["get", PAGE, null], "invalid method → get, empty action → page, bad maxlength ignored");
    const iso = only(page(`<form accept-charset="ISO-8859-1 utf-8"><input type="email" name="e"><textarea name="m"></textarea></form>`));
    assertEq(iso?.acceptCharset, "iso-8859-1", "accept-charset: first token");
    const meta = detectContactForms(`<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">`, PAGE, SITE);
    assertEq(meta.pageCharset, "iso-8859-1", "http-equiv charset");
  }

  // 12. Common CMS form markup (Contact Form 7) with English names.
  {
    const cf7 = only(page(`<div class="wpcf7"><form action="/kontakt/#wpcf7-f1" method="post" class="wpcf7-form">
      <p><label> Ditt navn<br><span><input type="text" name="your-name" class="wpcf7-form-control wpcf7-validates-as-required" aria-required="true"></span></label></p>
      <p><label> Din e-post<br><span><input type="email" name="your-email" aria-required="true"></span></label></p>
      <p><label> Emne<br><input type="text" name="your-subject"></label></p>
      <p><label> Din melding<br><textarea name="your-message" cols="40" rows="10"></textarea></label></p>
      <input type="submit" value="Send"></form></div>`));
    assertEq(
      cf7?.fields.map((x) => `${x.name}:${x.role}:${x.required}`),
      ["your-name:name:true", "your-email:email:true", "your-subject:subject:false", "your-message:message:false"],
      "cf7: wrapped labels + required classes",
    );
    assertEq(cf7?.skipReason, null, "cf7: no skip");
  }

  // 13. Robots: disallow for the form's action path (existing pure parser).
  {
    const robots = "User-agent: *\nDisallow: /kontakt\nAllow: /kontakt/info\n";
    const policy = parseRobotsTxt(robots);
    const f = only(page(PLAIN_FORM.replace('action="/send"', 'action="/kontakt/send"')));
    const actionPath = f?.action ? new URL(f.action).pathname + new URL(f.action).search : "";
    assertEq(isPathAllowed(policy, actionPath), false, "robots: Disallow /kontakt blocks the form action");
    assertEq(isPathAllowed(policy, "/kontakt/info"), true, "robots: longer Allow wins");
    assertEq(isPathAllowed(parseRobotsTxt("User-agent: *\nDisallow:\n"), "/kontakt/send"), true, "robots: empty Disallow allows");
  }

  // 14. Entities and Norwegian characters in labels.
  {
    assertEq(decodeEntities("Sp&oslash;rsm&aring;l &laquo;x&raquo; &#8212; &#xE6;"), "Spørsmål «x» — æ", "entities decoded");
    const f = only(page(`<form><label for="a">E-post</label><input id="a" name="a1"><label for="b">Sp&oslash;rsm&aring;l</label><input id="b" name="b1"></form>`));
    assertEq([roleOf(f, "a1"), roleOf(f, "b1")], ["email", "message"], "label via for= with entities: e-post + spørsmål");
  }

  // 15. Review B1: a submit control's formaction / formmethod overrides the form's.
  {
    // Reviewer's exact repro.
    const b1 = only(
      page(`<form action="/x"><input type="email" name="epost"><textarea name="melding"></textarea><button formaction="https://evil.com/x">Send</button></form>`),
    );
    assertEq(b1?.action, "https://www.gard.no/x", "B1: form action itself is on the producer site");
    assertEq(b1?.submitActions, [{ action: "https://evil.com/x", method: null }], "B1: button formaction recorded");
    assertEq(b1?.sameSiteAsProducer, false, "B1: button formaction to evil.com → not same site");
    assertEq(b1?.skipReason, "annet_domene", "B1: skip annet_domene");
    const FIELDS = `<input type="email" name="epost"><textarea name="melding"></textarea>`;
    const sub = only(page(`<form action="/x">${FIELDS}<input type="submit" formaction="https://evil.com/x"></form>`));
    assertEq(sub?.skipReason, "annet_domene", "B1: input type=submit formaction off-site");
    const img = only(page(`<form action="/x">${FIELDS}<input type="image" src="/b.png" formaction="//evil.com/x"></form>`));
    assertEq(img?.skipReason, "annet_domene", "B1: input type=image protocol-relative formaction off-site");
    const js = only(page(`<form action="/x">${FIELDS}<button type="submit" formaction="javascript:alert(1)">Send</button></form>`));
    assertEq(js?.sameSiteAsProducer, false, "B1: javascript: formaction → not same site");
    const ftp = only(page(`<form action="/x">${FIELDS}<button formaction="ftp://www.gard.no/x">Send</button></form>`));
    assertEq(ftp?.sameSiteAsProducer, false, "B1: ftp: formaction on own host → not same site");
    const own = only(page(`<form action="/x">${FIELDS}<button formaction="/y" formmethod="POST">Send</button></form>`));
    assertEq(own?.submitActions, [{ action: "https://www.gard.no/y", method: "post" }], "B1: own formaction + formmethod recorded");
    assertEq(own?.sameSiteAsProducer, true, "B1: own-site formaction stays same site");
    const empty = only(page(`<form action="/x">${FIELDS}<button formaction="">Send</button></form>`, '<base href="https://evil.com/">'));
    assertEq(empty?.submitActions[0]?.action, PAGE, "B1: empty formaction → document URL, not <base>");
    const plainBtn = only(page(`<form action="/x">${FIELDS}<button type="button" formaction="https://evil.com/x">Vis</button><button type="reset" formaction="https://evil.com/r">Nullstill</button></form>`));
    assertEq([plainBtn?.submitActions.length, plainBtn?.sameSiteAsProducer], [0, true], "B1: type=button/reset never submit");
    const invalidType = only(page(`<form action="/x">${FIELDS}<button type="bogus" formaction="https://evil.com/x">Send</button></form>`));
    assertEq(invalidType?.skipReason, "annet_domene", "B1: invalid button type defaults to submit");
    const methodOnly = only(page(`<form action="/x" method="post">${FIELDS}<button formmethod="get">Send</button></form>`));
    assertEq(methodOnly?.submitActions, [{ action: "https://www.gard.no/x", method: "get" }], "B1: formmethod alone recorded with form action");
    const outside = only(page(`<form id="k" action="/x">${FIELDS}</form><button form="k" formaction="https://evil.com/x">Send</button>`));
    assertEq(outside?.skipReason, "annet_domene", "B1: form= submit button outside the form is read");
    const upper = only(page(`<form action="/x">${FIELDS}<BUTTON FORMACTION="https://evil.com/x">Send</BUTTON></form>`));
    assertEq(upper?.skipReason, "annet_domene", "B1: upper-case FORMACTION");
  }

  // 16. Review B2: own host or a subdomain of it — never sibling, parent or co-tenant.
  {
    const FORM = `<form action="/x"><input type="email" name="epost"><textarea name="melding"></textarea></form>`;
    const ABS = (u: string) => `<form action="${u}"><input type="email" name="epost"><textarea name="melding"></textarea></form>`;
    // Reviewer's exact repros.
    assertEq(only(page(FORM), "https://b.oslo.no/x", "https://a.oslo.no")?.sameSiteAsProducer, false, "B2: b.oslo.no is not a.oslo.no");
    assertEq(only(page(FORM), "https://oslo.no", "https://a.oslo.no")?.sameSiteAsProducer, false, "B2: parent oslo.no is not a.oslo.no");
    assertEq(
      only(page(ABS("https://other.webador.no/x")), "https://gard.webador.no/kontakt", "https://gard.webador.no")?.sameSiteAsProducer,
      false,
      "B2: other.webador.no action is another tenant",
    );
    assertEq(only(page(FORM), "https://other.webador.no/x", "https://gard.webador.no")?.sameSiteAsProducer, false, "B2: page on other tenant");
    assertEq(only(page(FORM), "https://shop.gard.no/x", "https://sub.gard.no")?.sameSiteAsProducer, false, "B2: sibling shop.gard.no");
    assertEq(only(page(ABS("https://shop.gard.no/x")), "https://sub.gard.no/k", "https://sub.gard.no")?.sameSiteAsProducer, false, "B2: sibling action");
    assertEq(only(page(FORM), "https://gard.no/x", "https://sub.gard.no")?.sameSiteAsProducer, false, "B2: parent gard.no of sub.gard.no");
    // Still same site.
    assertEq(only(page(FORM), "https://gard.webador.no/kontakt", "https://gard.webador.no")?.sameSiteAsProducer, true, "B2: own tenant host");
    assertEq(only(page(FORM), "https://a.oslo.no/kontakt", "https://a.oslo.no")?.sameSiteAsProducer, true, "B2: own host a.oslo.no");
    assertEq(only(page(FORM), "https://www.sub.gard.no/k", "https://sub.gard.no")?.sameSiteAsProducer, true, "B2: www of own host");
    assertEq(only(page(FORM), "https://gard.no/k", "https://www.gard.no")?.sameSiteAsProducer, true, "B2: www. stripped from producer");
    assertEq(only(page(ABS("https://skjema.sub.gard.no/x")), "https://sub.gard.no/k", "https://sub.gard.no")?.sameSiteAsProducer, true, "B2: subdomain of own host");
    assertEq(producerOwnHost("https://www.Sub.Gard.no/"), "sub.gard.no", "B2: producerOwnHost keeps subdomains, strips www.");
    assertEq(producerOwnHost("https://co.uk"), null, "B2: bare public suffix is nobody's host");
    assertEq(producerOwnHost("https://www.facebook.com/gard"), null, "B2: social platform is never the producer's host");
    assertEq(urlIsOnProducerHost("https://gard.priv.no/x", "other.priv.no"), false, "B2: other.priv.no");
  }

  // 17. Review N6: tests for the mutants that survived.
  {
    // M1: page on a foreign domain, absolute action back to the producer.
    const m1 = only(
      page(PLAIN_FORM.replace('action="/send"', 'action="https://www.gard.no/send"')),
      "https://evil.example.com/kontakt",
    );
    assertEq([m1?.sameSiteAsProducer, m1?.skipReason], [false, "annet_domene"], "N6/M1: foreign page with producer action");
    // M4: non-http protocol on the producer's host.
    const m4 = only(page(PLAIN_FORM.replace('action="/send"', 'action="ftp://gard.no/x"')));
    assertEq(m4?.skipReason, "annet_domene", "N6/M4: ftp://gard.no action");
    assertEq(urlIsOnProducerHost("ftp://gard.no/x", "gard.no"), false, "N6/M4: urlIsOnProducerHost rejects ftp");
    // M9: <form> markup inside <script> is not a form.
    const m9 = detectContactForms(
      page(`<script>var t = '<form action="https://evil.com"><textarea name="m"></textarea></form>';</script>` + PLAIN_FORM),
      PAGE,
      SITE,
    );
    assertEq([m9.formsTotal, m9.forms[0]?.action], [1, "https://www.gard.no/send"], "N6/M9: <script> content is raw text");
    // M8: a nested <form> is ignored; the outer form's action stands.
    const m8 = detectContactForms(
      page(`<form action="/a"><form action="https://evil.com/x"><input type="email" name="e"><textarea name="m"></textarea></form>`),
      PAGE,
      SITE,
    );
    assertEq([m8.formsTotal, m8.forms[0]?.action, m8.forms[0]?.sameSiteAsProducer], [1, "https://www.gard.no/a", true], "N6/M8: nested form ignored");
    // M13: captcha iframe inside the form.
    const m13 = only(page(PLAIN_FORM.replace("<button", '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe><button')));
    assertEq([m13?.captcha, m13?.skipReason], [true, "captcha"], "N6/M13: recaptcha iframe in form");
  }

  // 18. Review N1: prefer a <textarea> as the message field and use its maxlength.
  {
    const f = only(
      page(`<form><input type="text" name="melding_kort" maxlength="20"><input type="email" name="e"><textarea name="melding" maxlength="2000"></textarea></form>`),
      PAGE,
      SITE,
      100,
    );
    assertEq([f?.messageMaxLength, f?.skipReason], [2000, null], "N1: textarea preferred over text input named melding");
    const single = only(page(`<form><input type="email" name="e"><input type="text" name="melding" maxlength="50"></form>`), PAGE, SITE, 60);
    assertEq([single?.messageMaxLength, single?.skipReason], [50, "melding_for_lang"], "N1: only a text input → its maxlength");
  }

  // 19. Review N2: more captcha shapes.
  {
    const cases: Array<[string, string, string]> = [
      ["cookiebot data-src recaptcha", PLAIN_FORM, '<script type="text/plain" data-cookieconsent="marketing" data-src="https://www.google.com/recaptcha/api.js"></script>'],
      ["link preload recaptcha", PLAIN_FORM, '<link rel="preload" as="script" href="https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js">'],
      ["altcha widget", PLAIN_FORM.replace("<button", '<altcha-widget challengeurl="/altcha"></altcha-widget><button'), ""],
      ["altcha script", PLAIN_FORM, '<script type="module" src="https://cdn.jsdelivr.net/npm/altcha/dist/altcha.min.js"></script>'],
      ["arkose script", PLAIN_FORM, '<script src="https://client-api.arkoselabs.com/v2/ABC/api.js" data-callback="setup"></script>'],
      ["funcaptcha", PLAIN_FORM, '<script src="https://api.funcaptcha.com/fc/api/"></script>'],
      ["friendly-challenge script", PLAIN_FORM, '<script type="module" src="https://cdn.jsdelivr.net/npm/friendly-challenge@0.9.12/widget.module.min.js" async defer></script>'],
      ["image captcha", PLAIN_FORM.replace("<button", '<img src="/captcha.php?r=1"><button'), ""],
    ];
    for (const [name, body, head] of cases) {
      assertEq(only(page(body, head))?.skipReason, "captcha", `N2: ${name} → captcha`);
    }
  }

  // 20. Review N3: messageLength must be a finite number >= 0.
  {
    for (const bad of [NaN, -1, Infinity]) {
      let threw = false;
      try {
        detectContactForms(page(PLAIN_FORM), PAGE, SITE, bad);
      } catch (e) {
        threw = e instanceof RangeError;
      }
      assertEq(threw, true, `N3: detectContactForms throws on messageLength ${bad}`);
      let threw2 = false;
      try {
        formSkipReason({ captcha: false, sameSiteAsProducer: true, phoneRequired: false, messageMaxLength: 10, fields: [] }, bad);
      } catch (e) {
        threw2 = e instanceof RangeError;
      }
      assertEq(threw2, true, `N3: formSkipReason throws on messageLength ${bad}`);
    }
  }

  // 21. Review N4: maxlength parsed as a browser does.
  {
    assertEq(
      ["10.5", "10abc", " 10", "+7", "-0", "-5", "abc", "", "99999999999999999999"].map((v) => parseMaxLength(v)),
      [10, 10, 10, 7, 0, null, null, null, null],
      "N4: leading-integer maxlength parsing",
    );
    const f = only(page(`<form><input type="email" name="e"><textarea name="m" maxlength="10.5"></textarea></form>`), PAGE, SITE, 11);
    assertEq([f?.messageMaxLength, f?.skipReason], [10, "melding_for_lang"], "N4: maxlength 10.5 → 10, 11 chars too long");
  }

  // 22. Review N5: raw-text elements do not open forms.
  {
    const EVIL = `<form action="https://evil.com/x"><input type="email" name="e"><textarea name="m"></textarea></form>`;
    for (const tag of ["title", "xmp", "noscript", "template", "textarea", "style"]) {
      const s = detectContactForms(page(`<${tag}><form action="/own"></${tag}>${EVIL}`), PAGE, SITE);
      assertEq(
        [s.formsTotal, s.forms[0]?.action, s.forms[0]?.skipReason],
        [1, "https://evil.com/x", "annet_domene"],
        `N5: unclosed <form> inside <${tag}> does not hide the real form`,
      );
    }
    const tpl = detectContactForms(page(`<template>${EVIL}</template>`), PAGE, SITE);
    assertEq(tpl.formsTotal, 0, "N5: a form inside <template> is inert");
    const ns = detectContactForms(page(`<noscript><iframe src="https://www.google.com/recaptcha/api/fallback"></iframe></noscript>${PLAIN_FORM}`), PAGE, SITE);
    assertEq(ns.pageCaptcha, true, "N5: captcha in <noscript> fallback still marks the page");
  }

  // 23. Review N8: an apostrophe in an unquoted attribute value does not swallow the page.
  {
    const s = detectContactForms(page(`<img alt=Ola's src=/x.png>${PLAIN_FORM}<p>Gården's butikk</p>`), PAGE, SITE);
    assertEq([s.formsTotal, s.forms.length, s.forms[0]?.fields.length], [1, 1, 9], "N8: alt=Ola's keeps the form");
    const f = only(page(`<form><input type=email name=e><textarea name=gjest's-melding></textarea></form>`));
    assertEq(f?.fields.map((x) => x.name), ["e", "gjest's-melding"], "N8: unquoted value keeps its apostrophe");
  }

  // 23b. Review r2 B1: an unquoted "<" inside a tag is a plain character, as
  // in a browser — `<b <form action="/a">` is ONE <b> tag (attributes "<form"
  // and "action"), so there is no form.
  {
    const s = detectContactForms(page(`<b <form action="/a"><input type="email" name="e"><textarea name="m"></textarea></form>`), PAGE, SITE);
    assertEq([s.formsTotal, s.forms.length], [0, 0], "r2 B1: '<b <form' is one <b> tag, no form");
  }

  // 23c. Review r2 B1: "<" inside a tag must not hide formaction, <base>,
  // the form's action or </form>. Each case posts to evil.com in a browser.
  {
    const FIELDS = `<input type="email" name="e"><textarea name="m"></textarea>`;
    const cases: Array<[string, string]> = [
      [
        "formaction after data-x=a<b",
        `<form action="/send" method="post">${FIELDS}<button formaction="https://evil.com" data-x=a<b>Send</button></form>`,
      ],
      [
        "data-x=a<b before formaction",
        `<form action="/send" method="post">${FIELDS}<button data-x=a<b formaction="https://evil.com/x">Send</button></form>`,
      ],
      [
        "input type=submit formaction with a<b",
        `<form action="/send" method="post">${FIELDS}<input type=submit data-x=a<b formaction=https://evil.com></form>`,
      ],
      ["base href with a<b", `<base data-x=a<b href="https://evil.com/"><form action="send" method="post">${FIELDS}</form>`],
      ["form action with a<b", `<form data-x=a<b action="https://evil.com/send" method="post">${FIELDS}</form>`],
      ["form action with bare < attribute", `<form < action="https://evil.com/send" method="post">${FIELDS}</form>`],
      [
        "</form> with a<b, button after it",
        `<form id="k" action="/send" method="post">${FIELDS}<div data-x=a<b></div><button formaction="https://evil.com">Send</button></form>`,
      ],
      [
        "fake </form> inside a tag with a<b",
        `<form action="/send" method="post">${FIELDS}<p data-x=a<b title=</form>></p><button formaction="https://evil.com">Send</button></form>`,
      ],
      [
        "</form_x> is not </form>",
        `<form action="/send" method="post">${FIELDS}</form_x><button formaction="https://evil.com">Send</button></form>`,
      ],
      [
        "bogus comment <! … > hides a </form>",
        `<form action="/send" method="post">${FIELDS}<! </form> ><button formaction="https://evil.com">Send</button></form>`,
      ],
      [
        "first <base href> wins",
        `<base href="https://evil.com/"><base href="https://www.gard.no/"><form action="send" method="post">${FIELDS}</form>`,
      ],
    ];
    for (const [name, body] of cases) {
      const s = detectContactForms(page(body), PAGE, SITE);
      assertEq(s.forms.length, 1, `r2 B1: ${name} — form found`);
      assertEq(s.forms[0]?.sameSiteAsProducer, false, `r2 B1: ${name} — not same-site`);
      assertEq(s.forms[0]?.skipReason, "annet_domene", `r2 B1: ${name} — skip annet_domene`);
    }
    // The resolved URLs, so the test pins WHY it is not same-site.
    const f1 = only(page(cases[0]![1]));
    assertEq(f1?.submitActions.map((a) => a.action), ["https://evil.com/"], "r2 B1: formaction read past a<b");
    const fb = only(page(cases[3]![1]));
    assertEq(fb?.action, "https://evil.com/send", "r2 B1: <base href> read past a<b");
    const ff = only(page(cases[4]![1]));
    assertEq(ff?.action, "https://evil.com/send", "r2 B1: form action read past a<b");
    // A harmless "<" in a value keeps an own-site form same-site.
    const ok = only(page(`<form action="/send" method="post">${FIELDS}<button data-x=a<b>Send</button></form>`));
    assertEq([ok?.sameSiteAsProducer, ok?.skipReason], [true, null], "r2 B1: a<b alone keeps own-site form usable");
    // Fail closed: the page ends inside a tag → no form on it is same-site.
    const cut = detectContactForms(page(`<form action="/send" method="post">${FIELDS}</form>`) + `<button form=x formaction="https://evil.com"`, PAGE, SITE);
    assertEq([cut.forms.length, cut.forms[0]?.sameSiteAsProducer], [1, false], "r2 B1: unterminated tag → fail closed");
    const cutQ = detectContactForms(page(`<form action="/send" method="post">${FIELDS}</form><p title="never closed>`), PAGE, SITE);
    assertEq(cutQ.forms[0]?.sameSiteAsProducer, false, "r2 B1: unclosed quoted value → fail closed");
    // Truncated at the size limit → fail closed too.
    const big = page(`<form action="/send" method="post">${FIELDS}</form>`) + " ".repeat(CONTACT_FORM_MAX_HTML_CHARS);
    assertEq(detectContactForms(big, PAGE, SITE).forms[0]?.sameSiteAsProducer, false, "r2 B1: truncated page → fail closed");
    // Attribute parsing follows the browser: quotes only after "=", first wins, "=" may start a name.
    const q = only(page(`<form action="/send" method="post">${FIELDS}<button =" formaction="https://evil.com">S</button></form>`));
    assertEq(q?.sameSiteAsProducer, false, "r2 B1: '=\"' as attribute name does not swallow formaction");
    const dup = only(page(`<form action="https://evil.com/" action="/send" method="post">${FIELDS}</form>`));
    assertEq(dup?.action, "https://evil.com/", "r2 B1: duplicate attribute — first wins");
    const sc = only(page(`<form action="/send"/method="post">${FIELDS}</form>`));
    assertEq([sc?.action, sc?.method], ["https://www.gard.no/send", "post"], "r2 B1: '/' between attributes");
  }

  // 23d. Review r2 B2: a website with a path on an unknown host is not the
  // producer's own host; a root website is.
  {
    const PORTAL = "https://www.lokalmatportal.no/produsent/gard";
    const FORM = `<form action="/send" method="post"><input type="email" name="e"><textarea name="m"></textarea></form>`;
    assertEq(producerOwnHost(PORTAL), null, "r2 B2: deep page on an unknown host has no own host");
    const deep = detectContactForms(page(FORM), "https://www.lokalmatportal.no/kontakt", PORTAL);
    assertEq([deep.producerDomain, deep.forms[0]?.sameSiteAsProducer, deep.forms[0]?.skipReason], [null, false, "annet_domene"], "r2 B2: portal form is not the producer's");
    const deepSame = detectContactForms(page(FORM), "https://www.lokalmatportal.no/produsent/gard", PORTAL);
    assertEq(deepSame.forms[0]?.sameSiteAsProducer, false, "r2 B2: even on the producer's own portal page");
    assertEq(producerOwnHost("https://www.gard.no/"), "gard.no", "r2 B2: root website with /");
    assertEq(producerOwnHost("gard.no"), "gard.no", "r2 B2: bare root website");
    assertEq(producerOwnHost("https://www.gard.no/no"), "gard.no", "r2 B2: language root /no counts as root");
    assertEq(producerOwnHost("https://www.gard.no/?ref=x#top"), "gard.no", "r2 B2: query/fragment ignored");
    const root = detectContactForms(page(FORM), "https://www.gard.no/kontakt", "https://www.gard.no/");
    assertEq([root.producerDomain, root.forms[0]?.sameSiteAsProducer], ["gard.no", true], "r2 B2: root website → own-host match");
  }

  // 23e. Review r2 B3: `form=` buttons belong only to the FIRST form with that
  // id; many forms sharing an id with many such buttons stay fast.
  {
    const FIELDS = `<input type="email" name="e"><textarea name="m"></textarea>`;
    const s = detectContactForms(
      page(`<form id="k" action="/a">${FIELDS}</form><form id="k" action="/b">${FIELDS}</form><button form="k" formaction="https://evil.com">S</button>`),
      PAGE,
      SITE,
    );
    assertEq(
      s.forms.map((f) => [f.action, f.sameSiteAsProducer]),
      [["https://www.gard.no/a", false], ["https://www.gard.no/b", true]],
      "r2 B3: form= button only on the first form with the id",
    );
    const unit = `<form id="x">${FIELDS}</form>`;
    const btn = `<button form="x" formaction="/ok">S</button>`;
    const k = Math.floor(CONTACT_FORM_MAX_HTML_CHARS / 2 / unit.length);
    const kb = Math.floor(CONTACT_FORM_MAX_HTML_CHARS / 2 / btn.length);
    const html = unit.repeat(k) + btn.repeat(kb);
    const t0 = Date.now();
    const r = detectContactForms(html, PAGE, SITE);
    const ms = Date.now() - t0;
    if (log) console.log(`    timing r2 B3 shared id: ${k} forms + ${kb} buttons, ${html.length} chars in ${ms} ms`);
    assertEq(ms < 2000, true, `r2 B3: ${k} forms sharing an id + ${kb} form= buttons (${html.length} chars) under 2 s`);
    assertEq([r.formsTotal, r.forms[0]?.submitActions.length, r.forms[1]?.submitActions.length], [k, kb, 0], "r2 B3: buttons counted once, on the first form");
  }

  // 23f. Review N4: method=dialog (form or formmethod) sends nothing → skip.
  {
    const FIELDS = `<input type="email" name="e"><textarea name="m"></textarea>`;
    const d = only(page(`<form method="dialog">${FIELDS}</form>`));
    assertEq([d?.method, d?.skipReason], ["dialog", "metode_dialog"], "N4: method=dialog → metode_dialog");
    const fm = only(page(`<form method="post" action="/send">${FIELDS}<button formmethod="dialog">Lukk</button></form>`));
    assertEq(fm?.skipReason, "metode_dialog", "N4: formmethod=dialog → metode_dialog");
    const cap = only(page(`<form method="dialog">${FIELDS}<div class="g-recaptcha"></div></form>`));
    assertEq(cap?.skipReason, "captcha", "N4: captcha still wins over dialog");
  }

  // 24. Review B3: tokenizing is linear — 2 MB of adversarial input in well under 2 s each.
  {
    const MB2 = CONTACT_FORM_MAX_HTML_CHARS;
    const fill = (unit: string): string => unit.repeat(Math.ceil(MB2 / unit.length)).slice(0, MB2);
    const shapes: Array<[string, string]> = [
      ['"<a".repeat(1e6)', "<a".repeat(1_000_000)],
      ["<a b= (repeated)", fill("<a b=")],
      ['<a b=" (repeated)', fill('<a b="')],
      ["<a b=' (repeated)", fill("<a b='")],
      ['<a b="<a c=\' (mixed quotes)', fill("<a b=\"<a c='")],
      ["<a x=y' (unquoted + quote)", fill("<a x=y'")],
      ["</a (close tags)", fill("</a ")],
      ["<!-- (comments)", fill("<!--")],
      ["<script> + </script (unterminated)", "<script>" + fill("</script ")],
      ['<form><textarea> + "<a" unclosed', "<form><textarea name=m>" + fill("<a")],
      ["<a = = (bare equals)", fill("<a = =")],
      // Shapes found by fuzzing a no-memo variant (quadratic there: ~1 s at 40 KB).
      ['<a"=" (quote after name)', fill('<a"="')],
      ["<a'x=' (quoted value swallows next tag)", fill("<a'x='")],
      ['""="<a', fill('""="<a')],
      ['<a<a"="', fill('<a<a"="')],
    ];
    for (const [name, html] of shapes) {
      const t0 = Date.now();
      detectContactForms(html, PAGE, SITE);
      const ms = Date.now() - t0;
      if (log) console.log(`    timing ${name}: ${html.length} chars in ${ms} ms`);
      assertEq(ms < 2000, true, `B3: ${name} (${html.length} chars) under 2 s`);
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runContactFormDetectorTests({ log: true });
  console.log(`\ncontact-form-detector: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
}
