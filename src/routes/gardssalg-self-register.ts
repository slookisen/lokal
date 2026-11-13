import express, { Router, Request, Response, NextFunction } from "express";
import { generalLimiter, gardssalgSelfRegisterLimiter } from "../middleware/security";
import {
  checkSameOriginWrite,
  writeGuardRefusedBody,
  WRITE_GUARD_REFUSED_TITLE,
  WRITE_GUARD_CONTACT_OPPLEVAGENT,
} from "../middleware/same-origin-write";
import { CONTACT_FORM_HONEYPOT_FIELD } from "../services/contact-form-only";
import {
  isGardssalgSelfRegisterEnabled,
  parseSelfRegisterForm,
  selfRegisterFormValues,
  submitSelfRegistration,
  SELF_REGISTER_PRODUCER_TYPES,
  SELF_REGISTER_FIELD_LIMITS,
  type SelfRegisterField,
  type SelfRegisterOutcome,
  type BrregRejectReason,
  issueSelfRegisterConfirmToken,
  confirmSelfRegisterEmail,
  verifySelfRegisterDraftSession,
  getSelfRegisterDraftProfile,
  SELF_REGISTER_CONFIRM_VALID_HOURS,
  SELF_REGISTER_DRAFT_SESSION_HOURS,
  SELF_REGISTER_DRAFT_COOKIE,
  SELF_REGISTER_DRAFT_COOKIE_PATH,
  notifyAdminSelfRegisterConfirmed,
  type SelfRegisterDraftProfile,
} from "../services/gardssalg-self-register";
import { updateClaimedProviderProfile } from "../services/gardssalg-claim";
import { OWNER_BOOKING_PENDING_REVIEW_MSG } from "../services/gardssalg-booking-gate";
import { emailService } from "../services/email-service";

// ─────────────────────────────────────────────────────────────────
// GÅRDSSALG SELF-REGISTRATION — /for-tilbydere/registrer
// dev-request 2026-11-01-opplevagent-drikkeprodusent-selvregistrering,
// skive 1 (form + duplicate check + Brreg gate + RFB filters + hidden row).
// ─────────────────────────────────────────────────────────────────
// Mounted by experiences-seo.ts (router.use, right after /for-tilbydere/finn),
// so it is reached on opplevagent.no only, behind that host gate, and an
// unmatched request falls through to that router's own 404 page.
//
// GARDSSALG_SELF_REGISTER_ENABLED off (the default): both routes call
// next("route") before anything else runs — no limiter is counted, no body is
// parsed — and the request ends on experiences-seo's ordinary 404, exactly as
// before this file existed (AC1).
//
// POST chain, in order: the flag; generalLimiter (the shared instance, one
// quota with /sok and /for-tilbydere/finn; ac2LimitersFor counts the path);
// gardssalgSelfRegisterLimiter (this form's own IP limit, registrationLimiter's
// shape); the urlencoded body parser; the shared same-origin write guard
// (middleware/same-origin-write.ts — `Origin: null` from a plain form POST
// under Referrer-Policy: no-referrer is allowed, a foreign Origin or
// Sec-Fetch-Site: cross-site/same-site is refused); the honeypot; then the
// service (services/gardssalg-self-register.ts) does every other check.
//
// Skive 2 adds, under the same flag gate: the e-mail code sent after a
// "created" outcome, the confirm page (GET .../bekreft renders a button and
// changes nothing; POST .../bekreft confirms and issues the draft-mode
// session), and the draft editor (GET/POST .../utkast) for the
// hidden row. Both POSTs run the same shared same-origin write guard as the
// form above (Origin: null from a plain form under no-referrer is allowed).
// Nothing is published from here (skive 3 approves, through the admin queue
// in routes/opplevelser.ts).
//
// Skive 3 (review N3 of lokal#1534): the draft session has its own cookie,
// oa_selfreg_draft, Path=/for-tilbydere/registrer — no longer the real
// owner's oa_owner_session, so confirming a registration never logs a real
// owner out, and the ordinary owner routes (which read oa_owner_session
// only) never receive it. The draft token is still refused there anyway.
// The confirm POST also sends the admin notice (once). The pages are
// noindex,nofollow and the path prefix is Disallow'd in robots.txt
// (GARDSSALG_ROBOTS_DISALLOWS, experiences-seo.ts).

export const GARDSSALG_SELF_REGISTER_PATH = "/for-tilbydere/registrer";
export const GARDSSALG_SELF_REGISTER_CONFIRM_PATH = "/for-tilbydere/registrer/bekreft";
export const GARDSSALG_SELF_REGISTER_DRAFT_PATH = "/for-tilbydere/registrer/utkast";
const OPPLEVAGENT_BASE_URL = (process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no").replace(/\/$/, "");
export const SELF_REGISTER_CONTACT = "kontakt@opplevagent.no";
const ROBOTS_NOINDEX = `<meta name="robots" content="noindex, nofollow">`;

/** The page shell experiences-seo.ts hands in (its forTilbyderePage), so this
 *  form wears the same chrome as /for-tilbydere and /for-tilbydere/finn. */
export type SelfRegisterPageRenderer = (opts: {
  title: string;
  metaDesc: string;
  robotsMeta: string;
  canonical: string;
  jsonLd: string;
  main: string;
  extraCss?: string;
}) => string;

function escapeHtml(text: string): string {
  const map: { [key: string]: string } = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return String(text ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

const SELF_REGISTER_CSS = `
  .sr-form{max-width:640px;margin:20px 0 8px}
  .sr-field{margin-bottom:16px}
  .sr-field label{display:block;font-weight:700;font-size:.93rem;color:var(--ink);margin-bottom:5px}
  .sr-field input,.sr-field select,.sr-field textarea{width:100%;min-height:44px;padding:10px 12px;font-size:1rem;font-family:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px}
  .sr-field textarea{min-height:110px;resize:vertical}
  .sr-field .hint{font-size:.8rem;color:var(--ink-soft);margin-top:4px}
  .sr-field .err{font-size:.85rem;color:#991b1b;margin-top:4px}
  .sr-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .sr-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 22px;font-size:1rem;font-weight:700;border:none;border-radius:999px;cursor:pointer;background:var(--fjord-800);color:#fff;font-family:inherit}
  .sr-btn:hover{background:var(--fjord-700)}
  .sr-btn-secondary{background:var(--surface);color:var(--fjord-800);border:1px solid var(--fjord-800)}
  .sr-alert{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--fjord-800);border-radius:0 8px 8px 0;padding:16px 18px;margin:18px 0;max-width:64ch}
  .sr-alert.err{border-left-color:#b91c1c}
  .sr-cands{margin:12px 0 0 20px}
  .sr-cands li{margin-bottom:6px}
`;

function page(render: SelfRegisterPageRenderer, title: string, main: string): string {
  return render({
    title: `${title} | Opplevagent`,
    metaDesc: "Registrer en gårdssalg- eller drikkeprodusent på Opplevagent.",
    robotsMeta: ROBOTS_NOINDEX,
    canonical: "",
    jsonLd: "",
    main: `<nav class="breadcrumb" aria-label="Brødsmulesti"><a href="/">Forsiden</a> · <a href="/for-tilbydere">For tilbydere</a> · Registrer bedriften</nav>\n${main}`,
    extraCss: SELF_REGISTER_CSS,
  });
}

function send(res: Response, status: number, html: string): void {
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
}

// ── The form ────────────────────────────────────────────────────────────────

function fieldHtml(opts: {
  name: SelfRegisterField;
  label: string;
  value: string;
  error?: string;
  hint?: string;
  type?: string;
  required?: boolean;
  maxlength?: number;
  autocomplete?: string;
  textarea?: boolean;
}): string {
  const id = `sr-${opts.name}`;
  const req = opts.required ? " required" : "";
  const max = opts.maxlength ? ` maxlength="${opts.maxlength}"` : "";
  const ac = opts.autocomplete ? ` autocomplete="${opts.autocomplete}"` : "";
  const invalid = opts.error ? ` aria-invalid="true" aria-describedby="${id}-err"` : "";
  const control = opts.textarea
    ? `<textarea id="${id}" name="${opts.name}"${req}${max}${invalid}>${escapeHtml(opts.value)}</textarea>`
    : `<input id="${id}" name="${opts.name}" type="${opts.type || "text"}" value="${escapeHtml(opts.value)}"${req}${max}${ac}${invalid}>`;
  return `<div class="sr-field">
      <label for="${id}">${escapeHtml(opts.label)}${opts.required ? " *" : ""}</label>
      ${control}
      ${opts.hint ? `<div class="hint">${escapeHtml(opts.hint)}</div>` : ""}
      ${opts.error ? `<div class="err" id="${id}-err">${escapeHtml(opts.error)}</div>` : ""}
    </div>`;
}

export function selfRegisterFormHtml(
  values: Record<string, string>,
  errors: Partial<Record<SelfRegisterField, string>> = {},
  alert = "",
): string {
  const v = (k: string) => values[k] ?? "";
  const options = SELF_REGISTER_PRODUCER_TYPES.map(
    (t) => `<option value="${t.value}"${v("producer_type") === t.value ? " selected" : ""}>${escapeHtml(t.label)}</option>`,
  ).join("");
  return `<header class="head ft-hero">
    <h1>Registrer bedriften din</h1>
    <p class="lede">Finner du ikke bedriften din hos oss? Registrer den her. Vi sjekker organisasjonsnummeret mot Brønnøysundregistrene, og profilen blir ikke synlig før vi har vurdert registreringen manuelt.</p>
  </header>
  ${alert}
  <form class="sr-form" method="post" action="${GARDSSALG_SELF_REGISTER_PATH}" novalidate>
    <div class="sr-hp" aria-hidden="true">
      <label for="sr-hp">La dette feltet stå tomt</label>
      <input id="sr-hp" type="text" name="${CONTACT_FORM_HONEYPOT_FIELD}" value="" tabindex="-1" autocomplete="off">
    </div>
    ${fieldHtml({ name: "org_nr", label: "Organisasjonsnummer", value: v("org_nr"), error: errors.org_nr, required: true, maxlength: 20, hint: "9 siffer. Gårdssalg av alkohol krever et registrert foretak." })}
    ${fieldHtml({ name: "company_name", label: "Bedriftsnavn", value: v("company_name"), error: errors.company_name, required: true, maxlength: SELF_REGISTER_FIELD_LIMITS.companyName, autocomplete: "organization", hint: "Slik det står i Brønnøysundregistrene." })}
    ${fieldHtml({ name: "place", label: "Kommune eller poststed", value: v("place"), error: errors.place, required: true, maxlength: SELF_REGISTER_FIELD_LIMITS.place })}
    <div class="sr-field">
      <label for="sr-producer_type">Hva lager dere? *</label>
      <select id="sr-producer_type" name="producer_type" required>
        <option value="">Velg …</option>${options}
      </select>
      ${errors.producer_type ? `<div class="err">${escapeHtml(errors.producer_type)}</div>` : ""}
    </div>
    ${fieldHtml({ name: "description", label: "Kort beskrivelse", value: v("description"), error: errors.description, maxlength: SELF_REGISTER_FIELD_LIMITS.description, textarea: true })}
    ${fieldHtml({ name: "website", label: "Nettside", value: v("website"), error: errors.website, maxlength: SELF_REGISTER_FIELD_LIMITS.website, autocomplete: "url" })}
    ${fieldHtml({ name: "submitter_name", label: "Ditt navn", value: v("submitter_name"), error: errors.submitter_name, required: true, maxlength: SELF_REGISTER_FIELD_LIMITS.submitterName, autocomplete: "name" })}
    ${fieldHtml({ name: "email", label: "Din e-post", value: v("email"), error: errors.email, required: true, type: "email", maxlength: 254, autocomplete: "email", hint: "Vi bruker den bare til å kontakte deg om registreringen. Den vises ikke på profilen." })}
    ${fieldHtml({ name: "phone", label: "Telefon", value: v("phone"), error: errors.phone, type: "tel", maxlength: SELF_REGISTER_FIELD_LIMITS.phone, autocomplete: "tel" })}
    <button type="submit" class="sr-btn">Send registreringen</button>
  </form>`;
}

// ── Outcome pages ───────────────────────────────────────────────────────────

const BRREG_REJECT_MESSAGES: Record<BrregRejectReason, string> = {
  not_found: "Vi fant ikke organisasjonsnummeret i Brønnøysundregistrene. Sjekk at det er skrevet riktig.",
  inactive: "Ifølge Brønnøysundregistrene er foretaket ikke aktivt (slettet, konkurs eller under avvikling). Vi kan derfor ikke registrere det.",
  wrong_nace: "Næringskoden foretaket er registrert med i Brønnøysundregistrene, passer ikke for gårdssalg og drikkeproduksjon. Vi kan derfor ikke registrere det automatisk.",
  name_mismatch: "Bedriftsnavnet stemmer ikke med navnet som er registrert på organisasjonsnummeret i Brønnøysundregistrene.",
};

function contactLine(): string {
  return `Mener du at dette er feil, kan du skrive til <a href="mailto:${SELF_REGISTER_CONTACT}">${SELF_REGISTER_CONTACT}</a>, så ser vi på det.`;
}

function hiddenInputs(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, val]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(val)}">`)
    .join("\n    ");
}

function outcomePage(render: SelfRegisterPageRenderer, outcome: SelfRegisterOutcome, values: Record<string, string>): { status: number; html: string } {
  switch (outcome.kind) {
    case "created":
      return {
        status: 200,
        html: page(render, "Registreringen er mottatt", `<header class="head ft-hero"><h1>Registreringen er mottatt</h1></header>
  <div class="sr-alert" role="status" data-outcome="created">
    <p><strong>Takk! Vi har mottatt registreringen.</strong></p>
    <p>Organisasjonsnummeret er sjekket mot Brønnøysundregistrene. Registreringen vurderes nå manuelt, og profilen er ikke synlig for andre før den er godkjent. Vi tar kontakt på e-postadressen du oppga.</p>
    <p>Vi har sendt en lenke til e-postadressen du oppga. Åpne den og trykk «Bekreft», så kan du fylle ut profilen mens vi vurderer registreringen.</p>
  </div>
  <p><a href="/for-tilbydere">Tilbake til For tilbydere</a></p>`),
      };
    case "existing_hidden":
      return {
        status: 200,
        html: page(render, "Bedriften finnes allerede", `<header class="head ft-hero"><h1>Bedriften finnes allerede</h1></header>
  <div class="sr-alert" role="status" data-outcome="existing_hidden">
    <p>Dette organisasjonsnummeret er allerede registrert hos oss, men profilen er ikke offentlig nå. Vi har ikke laget en ny profil.</p>
    <p>Saken går til manuell vurdering, og vi tar kontakt på e-postadressen du oppga. Du kan også skrive til <a href="mailto:${SELF_REGISTER_CONTACT}">${SELF_REGISTER_CONTACT}</a>.</p>
  </div>`),
      };
    case "brreg_unavailable":
      return {
        status: 202,
        html: page(render, "Registreringen er mottatt", `<header class="head ft-hero"><h1>Registreringen er mottatt</h1></header>
  <div class="sr-alert" role="status" data-outcome="brreg_unavailable">
    <p>Vi fikk ikke kontakt med Brønnøysundregistrene akkurat nå, så organisasjonsnummeret er ikke sjekket ennå.</p>
    <p>Vi har lagret registreringen, men ingen profil er laget. Den vurderes manuelt, og vi tar kontakt på e-postadressen du oppga. Du kan også prøve igjen senere.</p>
  </div>`),
      };
    case "brreg_rejected":
      return {
        status: 422,
        html: page(render, "Registreringen ble ikke godkjent", `<header class="head ft-hero"><h1>Vi kunne ikke registrere bedriften</h1></header>
  <div class="sr-alert err" role="alert" data-outcome="brreg_rejected" data-reason="${outcome.reason}">
    <p>${escapeHtml(BRREG_REJECT_MESSAGES[outcome.reason])}</p>
    <p>Ingen profil er laget. ${contactLine()}</p>
  </div>
  ${selfRegisterFormHtml(values)}`),
      };
    case "blocked":
      return {
        status: 403,
        html: page(render, "Registreringen kan ikke tas imot", `<header class="head ft-hero"><h1>Registreringen kan ikke tas imot</h1></header>
  <div class="sr-alert err" role="alert" data-outcome="blocked">
    <p>Vi kan ikke ta imot denne registreringen. Skriv til <a href="mailto:${SELF_REGISTER_CONTACT}">${SELF_REGISTER_CONTACT}</a> hvis du har spørsmål.</p>
  </div>`),
      };
    case "content_rejected":
      return {
        status: 400,
        html: page(render, "Registrer bedriften din", selfRegisterFormHtml(
          values,
          { description: "Beskrivelsen ble avvist. Skriv en kort, vanlig tekst om bedriften, uten kode eller lenker." },
          `<div class="sr-alert err" role="alert" data-outcome="content_rejected">Registreringen er ikke sendt. Se feltet «Kort beskrivelse».</div>`,
        )),
      };
    case "paused":
      return {
        status: 423,
        html: page(render, "Registrering er midlertidig stengt", `<header class="head ft-hero"><h1>Registrering er midlertidig stengt</h1></header>
  <div class="sr-alert err" role="alert" data-outcome="paused">
    <p>Vi tar ikke imot nye registreringer akkurat nå. Prøv igjen senere, eller skriv til <a href="mailto:${SELF_REGISTER_CONTACT}">${SELF_REGISTER_CONTACT}</a>.</p>
  </div>`),
      };
    case "possible_duplicate": {
      const items: string[] = outcome.nameKommune.map((c) =>
        c.claimSlug
          ? `<li>${escapeHtml(c.navn)} — <a href="/kategori/gardssalg/eier/${encodeURIComponent(c.claimSlug)}">Ja, dette er oss: ta over profilen</a></li>`
          : `<li>${escapeHtml(c.navn)} (profilen er ikke offentlig nå)</li>`,
      );
      if (outcome.rfbAgent) {
        items.push(`<li>Det samme organisasjonsnummeret er registrert på Rett fra Bonden (rettfrabonden.com).</li>`);
      }
      return {
        status: 200,
        html: page(render, "Er dette deg?", `<header class="head ft-hero"><h1>Er dette deg?</h1></header>
  <div class="sr-alert" role="status" data-outcome="possible_duplicate">
    <p>Vi har allerede noe som ligner på bedriften din:</p>
    <ul class="sr-cands">${items.join("")}</ul>
    <p>Er en av disse din bedrift, bør du ta over den profilen i stedet for å lage en ny.</p>
  </div>
  <form method="post" action="${GARDSSALG_SELF_REGISTER_PATH}">
    ${hiddenInputs(values)}
    <input type="hidden" name="confirm_not_duplicate" value="1">
    <p>Er ingen av disse din bedrift, kan du registrere den likevel. Registreringen blir da vurdert manuelt.</p>
    <button type="submit" class="sr-btn sr-btn-secondary">Nei, dette er ikke oss. Registrer likevel</button>
  </form>`),
      };
    }
    case "existing_claimable":
      // Handled by the caller (303 redirect); never rendered.
      return { status: 500, html: "" };
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

function flagGate(_req: Request, _res: Response, next: NextFunction): void {
  if (isGardssalgSelfRegisterEnabled()) return next();
  next("route");
}

export function createGardssalgSelfRegisterRouter(render: SelfRegisterPageRenderer): Router {
  const router = Router();

  router.get(
    GARDSSALG_SELF_REGISTER_PATH,
    flagGate,
    generalLimiter,
    (req: Request, res: Response) => {
      const prefillName = typeof req.query.navn === "string" ? req.query.navn : "";
      const values = selfRegisterFormValues({ company_name: prefillName });
      send(res, 200, page(render, "Registrer bedriften din", selfRegisterFormHtml(values)));
    },
  );

  router.post(
    GARDSSALG_SELF_REGISTER_PATH,
    flagGate,
    generalLimiter,
    gardssalgSelfRegisterLimiter,
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req: Request, res: Response) => {
      if (checkSameOriginWrite(req, GARDSSALG_SELF_REGISTER_PATH).refused) {
        return send(res, 403, page(render, WRITE_GUARD_REFUSED_TITLE, writeGuardRefusedBody({
          contact: WRITE_GUARD_CONTACT_OPPLEVAGENT,
          backHref: GARDSSALG_SELF_REGISTER_PATH,
          backLabel: "Tilbake til skjemaet",
        })));
      }
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const honey = String(body[CONTACT_FORM_HONEYPOT_FIELD] ?? "");
      if (honey.length > 0) {
        console.log("[gardssalg-self-register] honeypot filled; dropped");
        return send(res, 400, page(render, "Registreringen ble ikke sendt", `<div class="sr-alert err" role="alert" data-outcome="honeypot">Registreringen kunne ikke sendes.</div>`));
      }

      const parsed = parseSelfRegisterForm(body);
      if (!parsed.ok) {
        return send(res, 400, page(render, "Registrer bedriften din", selfRegisterFormHtml(
          parsed.values,
          parsed.errors,
          `<div class="sr-alert err" role="alert" data-outcome="invalid">Registreringen er ikke sendt. Rett feltene som er merket.</div>`,
        )));
      }

      let outcome: SelfRegisterOutcome;
      try {
        outcome = await submitSelfRegistration(parsed.input);
      } catch (err) {
        console.error("[gardssalg-self-register] POST error:", err);
        return send(res, 500, page(render, "Noe gikk galt", `<div class="sr-alert err" role="alert">Noe gikk galt, og registreringen er ikke lagret. Prøv igjen senere, eller skriv til <a href="mailto:${SELF_REGISTER_CONTACT}">${SELF_REGISTER_CONTACT}</a>.</div>`));
      }

      if (outcome.kind === "existing_claimable") {
        return res.redirect(303, `/kategori/gardssalg/eier/${encodeURIComponent(outcome.slug)}`);
      }
      if (outcome.kind === "created") sendConfirmLink(outcome.registrationId);
      const { status, html } = outcomePage(render, outcome, selfRegisterFormValues(body));
      send(res, status, html);
    },
  );

  // ── Skive 2: confirm link (Spec D) ──────────────────────────────────────

  // GET: render the confirm button only. No lookup, no write — a mail
  // scanner that opens the link changes nothing.
  router.get(
    GARDSSALG_SELF_REGISTER_CONFIRM_PATH,
    flagGate,
    generalLimiter,
    (req: Request, res: Response) => {
      const t = typeof req.query.t === "string" ? req.query.t : "";
      send(res, 200, page(render, "Bekreft e-postadressen", `<header class="head ft-hero"><h1>Bekreft e-postadressen</h1></header>
  <div class="sr-alert" role="status" data-outcome="confirm_page">
    <p>Trykk på knappen for å bekrefte at e-postadressen er din. Etterpå kan du fylle ut profilen mens vi vurderer registreringen. Profilen blir ikke synlig før vi har godkjent den.</p>
  </div>
  <form method="post" action="${GARDSSALG_SELF_REGISTER_CONFIRM_PATH}">
    <input type="hidden" name="t" value="${escapeHtml(t)}">
    <button type="submit" class="sr-btn">Bekreft</button>
  </form>`));
    },
  );

  router.post(
    GARDSSALG_SELF_REGISTER_CONFIRM_PATH,
    flagGate,
    generalLimiter,
    express.urlencoded({ extended: false, limit: "4kb" }),
    (req: Request, res: Response) => {
      if (checkSameOriginWrite(req, GARDSSALG_SELF_REGISTER_CONFIRM_PATH).refused) return refused(res, GARDSSALG_SELF_REGISTER_PATH);
      const token = (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>).t : undefined);
      let result: ReturnType<typeof confirmSelfRegisterEmail>;
      try {
        result = confirmSelfRegisterEmail(token);
      } catch (err) {
        console.error("[gardssalg-self-register] confirm error:", err);
        return send(res, 500, page(render, "Noe gikk galt", `<div class="sr-alert err" role="alert">Noe gikk galt. Prøv igjen senere, eller skriv til <a href="mailto:${SELF_REGISTER_CONTACT}">${SELF_REGISTER_CONTACT}</a>.</div>`));
      }
      if (!result.ok) {
        const msg = result.error === "expired"
          ? "Lenken er utløpt."
          : result.error === "used"
          ? "Lenken er allerede brukt."
          : "Lenken er ikke gyldig.";
        return send(res, result.error === "expired" ? 410 : result.error === "used" ? 409 : 400, page(render, "Kunne ikke bekrefte", `<header class="head ft-hero"><h1>Kunne ikke bekrefte</h1></header>
  <div class="sr-alert err" role="alert" data-outcome="confirm_${result.error}">
    <p>${msg} Skriv til <a href="mailto:${SELF_REGISTER_CONTACT}">${SELF_REGISTER_CONTACT}</a>, så hjelper vi deg.</p>
  </div>`));
      }
      notifyAdminSelfRegisterConfirmed(result.registrationId);
      res.cookie(SELF_REGISTER_DRAFT_COOKIE, result.sessionToken, {
        path: SELF_REGISTER_DRAFT_COOKIE_PATH,
        maxAge: SELF_REGISTER_DRAFT_SESSION_HOURS * 3600 * 1000,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      });
      return res.redirect(303, GARDSSALG_SELF_REGISTER_DRAFT_PATH);
    },
  );

  // ── Skive 2: draft editor (Spec E) ──────────────────────────────────────

  router.get(
    GARDSSALG_SELF_REGISTER_DRAFT_PATH,
    flagGate,
    generalLimiter,
    (req: Request, res: Response) => {
      const session = verifySelfRegisterDraftSession(readDraftSessionCookie(req));
      const profile = session.valid && session.providerId ? getSelfRegisterDraftProfile(session.providerId) : null;
      if (!profile) return noDraftSession(res);
      const status = typeof req.query.status === "string" ? req.query.status : "";
      send(res, 200, page(render, "Utkast til profilen", draftEditorHtml(profile, status)));
    },
  );

  router.post(
    GARDSSALG_SELF_REGISTER_DRAFT_PATH,
    flagGate,
    generalLimiter,
    express.urlencoded({ extended: false, limit: "32kb" }),
    (req: Request, res: Response) => {
      if (checkSameOriginWrite(req, GARDSSALG_SELF_REGISTER_DRAFT_PATH).refused) return refused(res, GARDSSALG_SELF_REGISTER_DRAFT_PATH);
      const session = verifySelfRegisterDraftSession(readDraftSessionCookie(req));
      if (!session.valid || !session.providerId) return noDraftSession(res);
      const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      // CLAIM_EDITABLE_FIELDS through the owner portal's own writer. The form
      // has no booking switch; a posted one is passed on so the shared gate
      // (ownerBookingEnableBlock → pending_review) is what refuses it.
      const payload: Record<string, unknown> = {
        about_text: b.field_about_text,
        visit_text: b.field_visit_text,
        opening_hours_text: b.field_opening_hours_text,
        hjemmeside: b.field_hjemmeside,
      };
      // Review N1 (lokal#1534): only a posted product field is written — a
      // save without it must not wipe the stored product list.
      if ("field_products" in b) {
        payload.products = String(b.field_products ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      }
      // Review N2: "0" / "" / "off" are off; only "1", "on" and "true" are on.
      if ("field_booking_live" in b) payload.booking_live = parseDraftCheckbox(b.field_booking_live) ? 1 : 0;
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
      let outcome: ReturnType<typeof updateClaimedProviderProfile>;
      try {
        outcome = updateClaimedProviderProfile(session.providerId, payload);
      } catch (err) {
        console.error("[gardssalg-self-register] draft save error:", err);
        return res.redirect(303, `${GARDSSALG_SELF_REGISTER_DRAFT_PATH}?status=error`);
      }
      if (!outcome.ok && outcome.error === "booking_blocked") {
        const profile = getSelfRegisterDraftProfile(session.providerId);
        if (!profile) return noDraftSession(res);
        return send(res, 409, page(render, "Utkast til profilen", draftEditorHtml(profile, "booking_blocked")));
      }
      if (!outcome.ok) return res.redirect(303, `${GARDSSALG_SELF_REGISTER_DRAFT_PATH}?status=error`);
      return res.redirect(303, `${GARDSSALG_SELF_REGISTER_DRAFT_PATH}?status=saved`);
    },
  );

  function refused(res: Response, backHref: string): void {
    send(res, 403, page(render, WRITE_GUARD_REFUSED_TITLE, writeGuardRefusedBody({
      contact: WRITE_GUARD_CONTACT_OPPLEVAGENT,
      backHref,
      backLabel: "Tilbake",
    })));
  }

  function noDraftSession(res: Response): void {
    send(res, 401, page(render, "Lenken er ikke gyldig", `<header class="head ft-hero"><h1>Du er ikke logget inn</h1></header>
  <div class="sr-alert err" role="alert" data-outcome="no_draft_session">
    <p>Åpne lenken i e-posten vi sendte på nytt, eller skriv til <a href="mailto:${SELF_REGISTER_CONTACT}">${SELF_REGISTER_CONTACT}</a>.</p>
  </div>`));
  }

  return router;
}

// ── Skive 2 helpers ──────────────────────────────────────────────────────────

/** Issue the code and send it to the submitter's own typed address. Never
 *  throws into the request: a failed send is logged, the receipt still shows. */
function sendConfirmLink(registrationId: string): void {
  let issued: ReturnType<typeof issueSelfRegisterConfirmToken>;
  try {
    issued = issueSelfRegisterConfirmToken(registrationId);
  } catch (err) {
    console.error("[gardssalg-self-register] issue confirm token error:", err);
    return;
  }
  if (!issued) return;
  const confirmUrl = `${OPPLEVAGENT_BASE_URL}${GARDSSALG_SELF_REGISTER_CONFIRM_PATH}?t=${issued.token}`;
  Promise.resolve()
    .then(() => emailService.sendGardssalgSelfRegisterConfirmLink({
      to: issued!.to,
      providerName: issued!.providerName,
      confirmUrl,
      validHours: SELF_REGISTER_CONFIRM_VALID_HOURS,
    }))
    .then((r) => {
      if (!r.success) console.error(`[gardssalg-self-register] Failed to send confirm link for registration ${registrationId}`);
    })
    .catch((e) => console.error("[gardssalg-self-register] sendGardssalgSelfRegisterConfirmLink error:", e));
}

/** A posted checkbox/switch value: true only for "1", "on" or "true"
 *  (trimmed, any case). Exported for the tests. */
export function parseDraftCheckbox(v: unknown): boolean {
  const s = (Array.isArray(v) ? v[v.length - 1] : v);
  if (typeof s !== "string") return false;
  const t = s.trim().toLowerCase();
  return t === "1" || t === "on" || t === "true";
}

/** The draft session cookie (oa_selfreg_draft) — never oa_owner_session. */
function readDraftSessionCookie(req: Request): string | undefined {
  const fromMiddleware = (req as any).cookies?.[SELF_REGISTER_DRAFT_COOKIE] as string | undefined;
  if (fromMiddleware) return fromMiddleware;
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    if (pair.slice(0, idx).trim() !== SELF_REGISTER_DRAFT_COOKIE) continue;
    const value = pair.slice(idx + 1).trim();
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return undefined;
}

const DRAFT_STATUS_MESSAGES: Record<string, { cls: string; text: string }> = {
  saved: { cls: "", text: "Utkastet er lagret. Det blir synlig når registreringen er godkjent." },
  error: { cls: " err", text: "Klarte ikke å lagre. Prøv igjen." },
  booking_blocked: { cls: " err", text: OWNER_BOOKING_PENDING_REVIEW_MSG },
};

function draftEditorHtml(p: SelfRegisterDraftProfile, status: string): string {
  let products = "";
  try {
    const arr = JSON.parse(p.products || "[]");
    if (Array.isArray(arr)) products = arr.filter((x) => typeof x === "string").join(", ");
  } catch { /* ignore */ }
  const st = DRAFT_STATUS_MESSAGES[status];
  const alert = st ? `<div class="sr-alert${st.cls}" role="${st.cls ? "alert" : "status"}" data-status="${escapeHtml(status)}">${escapeHtml(st.text)}</div>` : "";
  const text = (name: string, label: string, value: string | null, max: number, area = true) => area
    ? `<div class="sr-field"><label for="d-${name}">${escapeHtml(label)}</label><textarea id="d-${name}" name="field_${name}" maxlength="${max}">${escapeHtml(value ?? "")}</textarea></div>`
    : `<div class="sr-field"><label for="d-${name}">${escapeHtml(label)}</label><input id="d-${name}" name="field_${name}" type="text" maxlength="${max}" value="${escapeHtml(value ?? "")}"></div>`;
  return `<header class="head ft-hero">
    <h1>${escapeHtml(p.navn)} — utkast</h1>
    <p class="lede">Profilen er ikke publisert. Den venter på at Opplevagent vurderer registreringen, og vises ikke for andre før den er godkjent.</p>
  </header>
  <div class="sr-alert" role="status" data-draft-mode="1">
    <p><strong>Utkastmodus.</strong> Du kan fylle ut profilen nå. Du kan ikke publisere den eller slå på booking før registreringen er godkjent.</p>
  </div>
  ${alert}
  <form class="sr-form" method="post" action="${GARDSSALG_SELF_REGISTER_DRAFT_PATH}">
    ${text("about_text", "Om gården", p.about_text, 2000)}
    ${text("visit_text", "Besøk og gårdssalg", p.visit_text, 2000)}
    ${text("opening_hours_text", "Åpningstider", p.opening_hours_text, 500)}
    ${text("products", "Produkter (skill med komma)", products, 5000, false)}
    ${text("hjemmeside", "Nettside (https://…)", p.hjemmeside, 2048, false)}
    <div class="sr-field" data-booking-state="pending_review">
      <label>Booking</label>
      <div class="hint">${escapeHtml(OWNER_BOOKING_PENDING_REVIEW_MSG)}</div>
    </div>
    <button type="submit" class="sr-btn">Lagre utkastet</button>
  </form>`;
}
