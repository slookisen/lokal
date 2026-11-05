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
  producerRegistrableDomain,
  urlIsOnDomain,
  decodeEntities,
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
    assertEq(producerRegistrableDomain("https://gard.wixsite.com/gard"), null, "platform website → no producer domain");
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
    assertEq(urlIsOnDomain("https://a.b.gard.no/x", "gard.no"), true, "urlIsOnDomain: deep subdomain");
    assertEq(urlIsOnDomain("https://ostegard.no/x", "gard.no"), false, "urlIsOnDomain: suffix without dot is not a subdomain");
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
