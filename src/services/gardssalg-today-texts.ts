// ─── Gårdssalg: «Slik virker det i dag» and the pilot invitation (O4-4) ────
//
// A2A dev-request 2026-11-12-opplevagent-o4-epost-og-tekster, slice O4-4.
// The texts that say what a gårdssalg owner gets TODAY (a visit request the
// producer confirms, free during the pilot, no sale of alcohol through the
// platform) and the pilot invitation, in one register.
//
// Texts: verbatim from tekstpakke OA-3 §2 and §4 (A2A marketing-drafts/
// 2026-11-12-opplevagent-tekstpakke-oa-3.md), approved by Daniel 2026-11-15.
// The package has these owner texts in Norwegian only («Eiertekstene er bare
// på norsk, med unntak av del 3»), so there is no English here. Do not reword
// here: a new or changed sentence goes through a text package first.
//
// Content rules (Daniel 12.11): the visit is described, not the drink; no
// product or brand names, strength, tasting notes, medals or drink prices;
// never «gratis smaking»; no «barn velkommen»; the gårdssalg law is referred
// to only as a proposal. The O4-4 test scans every owner- and guest-facing
// register for these.
//
// Flags (off unless exactly "true", read on every call):
//   GARDSSALG_TODAY_TEXTS_ENABLED — the «Slik virker det i dag» block at the
//     top of the gårdssalg «Mine valg». Off: the page is byte-identical.
//   GARDSSALG_TODAY_LAW_ENABLED — the `today.law` line inside that block.
//     OA-3: the sentence is checked against the hearing page again right
//     before it is shown, so it has its own switch (Daniel's step).
//
// The pilot invitation is sent by Daniel by hand from CRM; nothing here sends
// anything. renderPilotInvitation() only fills the placeholders.

export const GARDSSALG_TODAY_TEXTS_FLAG = "GARDSSALG_TODAY_TEXTS_ENABLED";
export const GARDSSALG_TODAY_LAW_FLAG = "GARDSSALG_TODAY_LAW_ENABLED";

/** Off unless exactly "true", read on every call. */
export function gardssalgTodayTextsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GARDSSALG_TODAY_TEXTS_FLAG] === "true";
}

/** Off unless exactly "true", read on every call. */
export function gardssalgTodayLawEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GARDSSALG_TODAY_LAW_FLAG] === "true";
}

// ─── Register: OA-3 §2 «Slik virker det i dag» (nb, verbatim) ──────────────

export const GARDSSALG_TODAY_TEXTS = {
  "today.heading": "Slik virker besøk gjennom Opplevagent",
  "today.request": "En gjest sender en forespørsel om besøk. Ingenting er avtalt før du har bekreftet.",
  "today.reply": "Du får e-post for hver forespørsel og kan bekrefte, foreslå et annet tidspunkt eller avslå. Svarer du ikke innen 60 timer, utløper forespørselen, og gjesten får beskjed.",
  "today.price": "Det er gratis å være med i piloten.",
  "today.noSales": "Opplevagent formidler besøket. Vi selger ikke alkohol og tar ikke imot betaling. Salg, servering og alderskontroll er ditt ansvar, etter bevillingene du har.",
  "today.content": "Profilen beskriver stedet og besøket, ikke varene. Alt som gjelder produktene dine, står på din egen nettside, som vi lenker til.",
  "today.pause": "Du kan slå «Ta imot besøk» av igjen når du vil.",
  "today.law": "Et forslag om utvidet gårdssalg har vært på høring og er til behandling. Det er ikke vedtatt. Besøk gjennom Opplevagent er ikke avhengig av forslaget.",
  "today.bookingOff": "Profilen din viser kontaktinformasjonen din. Gjester kan ikke sende forespørsler gjennom Opplevagent før du har slått på «Ta imot besøk».",
} as const satisfies Record<string, string>;

export type TodayTextKey = keyof typeof GARDSSALG_TODAY_TEXTS;

// ─── Register: OA-3 §4 the pilot invitation (nb, verbatim) ─────────────────
// Placeholders: {produsent} {fornavn} {svartid} {start_setning} {innlogging}
// {telefon} {personvern}; {krav_url} inside the start sentence.

export const GARDSSALG_PILOT_INVITATION_TEXTS = {
  "invite.subject": "Vil {produsent} være med i piloten på Opplevagent?",
  "invite.body": [
    "Hei {fornavn},",
    "",
    "Jeg heter Daniel og står bak Opplevagent. Takk for at du svarte oss {svartid}.",
    "",
    "Opplevagent er bygget slik at AI-assistenter som ChatGPT kan bruke den når folk spør hvor de kan dra på besøk. Nå starter jeg en liten pilot der noen få produsenter kan ta imot forespørsler om besøk gjennom Opplevagent, og jeg vil gjerne at {produsent} er med. Dette er tidlig, og jeg kan ikke love mange forespørsler med en gang. Derfor håper jeg at du vil hjelpe meg å teste det i praksis.",
    "",
    "{start_setning}",
    "",
    "Slik fungerer det:",
    "- En gjest sender en forespørsel om besøk, med tidspunkt og antall. Ingenting er avtalt før du har bekreftet.",
    "- Du får en e-post for hver forespørsel og kan bekrefte, foreslå et annet tidspunkt eller avslå. Svarer du ikke innen 60 timer, utløper forespørselen, og gjesten får beskjed.",
    "- Opplevagent formidler besøket. Vi selger ikke alkohol og tar ikke imot betaling. Salg, servering og alderskontroll er ditt ansvar, etter bevillingene du har.",
    "- Profilen beskriver stedet og besøket, ikke varene. Alt som gjelder produktene, står på din egen nettside, som vi lenker til.",
    "- Det er gratis å være med i piloten, og du kan ta pause eller slutte når du vil.",
    "",
    "Vil du være med, logger du inn her: {innlogging}. Under «Mine valg» bekrefter du adressen forespørslene skal sendes til, og slår på «Ta imot besøk».",
    "",
    "Har du spørsmål, svarer du på e-posten eller ringer meg på {telefon}. Vil du ikke ha flere e-poster fra oss om piloten, svarer du «nei takk».",
    "",
    "Hilsen",
    "Daniel Fredriksen",
    "Opplevagent",
    "",
    "Slik behandler vi personopplysninger: {personvern}",
  ].join("\n"),
  /** `{start_setning}` when the owner has not taken over the profile yet. */
  "invite.startSentence.notClaimed": "Først tar du over profilen din her: {krav_url}. Det tar et par minutter.",
} as const satisfies Record<string, string>;

export type PilotInvitationTextKey = keyof typeof GARDSSALG_PILOT_INVITATION_TEXTS;

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zæøå_]+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m,
  );
}

export interface PilotInvitationVars {
  produsent: string;
  fornavn: string;
  /** When they answered, as they know it, e.g. «i oktober». */
  svartid: string;
  /** The owner login page on Opplevagent. */
  innlogging: string;
  /** Filled in at sending; never written to A2A files. */
  telefon: string;
  /** The privacy page on opplevagent.no. */
  personvern: string;
  /** Has the owner taken over the profile? true: the start sentence is removed. */
  claimed: boolean;
  /** The take-over link; required when `claimed` is false. */
  krav_url?: string;
}

/**
 * The pilot invitation with only the placeholders filled (OA-3 §4). Nothing
 * is sent: Daniel sends it by hand from CRM. With the profile taken over, the
 * `{start_setning}` paragraph is removed (with its blank line).
 */
export function renderPilotInvitation(v: PilotInvitationVars): { subject: string; text: string } {
  const T = GARDSSALG_PILOT_INVITATION_TEXTS;
  let body: string = T["invite.body"];
  if (v.claimed) {
    body = body.replace("{start_setning}\n\n", "");
  } else {
    if (!v.krav_url) throw new Error("renderPilotInvitation: krav_url is required when the profile is not taken over");
    body = body.replace("{start_setning}", fill(T["invite.startSentence.notClaimed"], { krav_url: v.krav_url }));
  }
  const vars: Record<string, string> = {
    produsent: v.produsent, fornavn: v.fornavn, svartid: v.svartid,
    innlogging: v.innlogging, telefon: v.telefon, personvern: v.personvern,
  };
  return { subject: fill(T["invite.subject"], vars), text: fill(body, vars) };
}

// ─── «Slik virker det i dag» block (top of the gårdssalg «Mine valg») ──────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The keys shown, in order. Booking off for the profile (switch off or the
 * admin brake): `today.bookingOff` first and no `today.pause` («… av igjen»),
 * so no line promises a request the guest cannot send. `today.law` only with
 * GARDSSALG_TODAY_LAW_ENABLED.
 */
export function todayTextKeys(opts: { bookingOn: boolean; law: boolean }): TodayTextKey[] {
  const keys: TodayTextKey[] = opts.bookingOn ? [] : ["today.bookingOff"];
  keys.push("today.request", "today.reply", "today.price", "today.noSales", "today.content");
  if (opts.bookingOn) keys.push("today.pause");
  if (opts.law) keys.push("today.law");
  return keys;
}

/** The block's HTML (a card above the statistics). Only called with GARDSSALG_TODAY_TEXTS_ENABLED on. */
export function renderTodayBlock(opts: { bookingOn: boolean; law: boolean }): string {
  const T = GARDSSALG_TODAY_TEXTS;
  const items = todayTextKeys(opts)
    .map((k) => `\n          <li data-today="${escHtml(k)}">${escHtml(T[k])}</li>`)
    .join("");
  return `<div class="ep-card" data-today-block="${opts.bookingOn ? "on" : "off"}">
        <h2>${escHtml(T["today.heading"])}</h2>
        <ul>${items}
        </ul>
      </div>`;
}
