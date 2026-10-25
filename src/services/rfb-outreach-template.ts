// ─── RFB cold-outreach e-mail — the v4 templates (texts H and I) ──────────────
//
// dev-request 2026-10-22-rfb-utsending-v4, skive 2 (endring 1-6). The text is
// taken VERBATIM from A2A marketing-drafts/2026-10-22-utsendingstekster-v4-rfb.md
// (approved by Daniel 2026-10-22): H = first contact (`rfb-outreach-v4`),
// I = follow-up (`rfb-outreach-v4-followup`), J = thank-you reply (CS lane,
// rendered by renderRfbThankYouV4 so the exact text lives in code and is
// tested; the CS routine's SKILL uses it from A2A). Only the fields in the
// draft's field table are substituted.
//
// This is a PURE module (no I/O, no clock, no randomness): the platform-side
// daily send (services/rfb-marketing-daily.ts) renders it deterministically.
//
// Reused from Opplevagent v4 (lokal#1241), NOT duplicated: the name wash
// (cleanOutreachProviderName), Daniel's display name and the signature phone
// constant, and the month phrase for {måned}.
//
//   • Subject A «Har vi riktig info om {navn}?» / B «Spørsmål om varene til
//     {navn}» and the split "last hex digit of agent_id: even → A, odd → B"
//     (unchanged rule; the v2 text of B was «Profil-utkast for …»).
//   • Layout: one paragraph per source line, blank line between paragraphs,
//     no line break inside a paragraph. The one exception is the signature
//     block («Vennlig hilsen / Daniel Fredriksen / Rett fra Bonden / 905 737
//     34»), which the draft sets as consecutive lines and which the HTML
//     renderer keeps as a short line block.
//   • Canonical profile URL + the validate_profile_url class guard (exactly
//     one "://", ^https://rettfrabonden\.com/produsent/[a-z0-9-]+$).

import {
  GARDSSALG_OUTREACH_SIGNATURE_PHONE,
  cleanOutreachProviderName,
} from "./email-service";

export const RFB_OUTREACH_TEMPLATE_ID = "rfb-outreach-v4";
export const RFB_OUTREACH_FOLLOWUP_TEMPLATE_ID = "rfb-outreach-v4-followup";
export type RfbOutreachTemplateId = typeof RFB_OUTREACH_TEMPLATE_ID | typeof RFB_OUTREACH_FOLLOWUP_TEMPLATE_ID;

/** Daniel's mobile number (fixed value, same constant as Opplevagent v4). */
export const RFB_OUTREACH_SIGNATURE_PHONE = GARDSSALG_OUTREACH_SIGNATURE_PHONE;

export const RFB_OUTREACH_PRIVACY_LINE = "Slik behandler jeg opplysningene: https://rettfrabonden.com/personvern";

export type RfbOutreachSubjectVariant = "A" | "B";

/** «producer_id mod 2 == 0 → A, ellers B», applied to the last hex digit. */
export function rfbOutreachSubjectVariant(agentId: string): RfbOutreachSubjectVariant {
  const last = String(agentId ?? "").trim().toLowerCase().slice(-1);
  if (!/^[0-9a-f]$/.test(last)) return "A";
  return parseInt(last, 16) % 2 === 0 ? "A" : "B";
}

/** Subject for text H. `producerName` is washed here (cleanOutreachProviderName). */
export function rfbOutreachSubject(variant: RfbOutreachSubjectVariant, producerName: string): string {
  const navn = cleanOutreachProviderName(producerName);
  return variant === "A" ? `Har vi riktig info om ${navn}?` : `Spørsmål om varene til ${navn}`;
}

/** Producer count rounded DOWN to the nearest hundred (1 743 → 1 700). */
export function roundProducerCountDown(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.floor(total / 100) * 100;
}

/** 1700 → "1 700" — plain-space thousands separator, as the draft writes it. */
export function formatProducerCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * `{N}`: the producer count rounded down to hundreds, space as thousands
 * separator («1 700») — or null when the count cannot support the sentence
 * (fewer than 100 after rounding down, e.g. an empty/broken table). The
 * template has no fallback wording for that case, so a caller must not send
 * rather than invent one.
 */
export function rfbOutreachProducerCountLabel(producerCountTotal: number): string | null {
  const rounded = roundProducerCountDown(producerCountTotal);
  if (rounded < 100) return null;
  return formatProducerCount(rounded);
}

/** `{eier_url}` — the link behind «Ta eierskap her» on the profile page. */
export function rfbOwnerUrl(agentId: string): string {
  return `https://rettfrabonden.com/selger?agent=${agentId}`;
}

/** validate_profile_url from the canonical-url addendum, as a predicate. */
export function isValidRfbProfileUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  if (url.split("://").length - 1 !== 1) return false;
  return /^https:\/\/rettfrabonden\.com\/produsent\/[a-z0-9-]+$/.test(url);
}

export interface RfbOutreachRenderInput {
  /** Drives the A/B subject split and {eier_url}. */
  agentId: string;
  producerName: string;
  /** Canonical profile URL (already validated — see isValidRfbProfileUrl). */
  profileUrl: string;
  /** Raw producer count; rounded down to hundreds here. */
  producerCountTotal: number;
  /**
   * Optional first name for «Hei <fornavn>,». There is no such field in the
   * database, so the daily job never passes one — every e-mail opens «Hei,».
   */
  contactFirstName?: string | null;
  /**
   * Text I only: `{måned}` («i september», «tidligere denne måneden»), from
   * gardssalgOutreachMonthPhrase(). Required for the follow-up.
   */
  monthPhrase?: string;
  /**
   * Text I only: subject of the first mail when it exists in the CRM. The
   * follow-up is then `Re: <it>`; otherwise it is a new mail with subject A.
   */
  firstSubject?: string | null;
}

export interface RfbOutreachRendered {
  template: RfbOutreachTemplateId;
  variant: RfbOutreachSubjectVariant;
  subject: string;
  text: string;
}

export class RfbOutreachRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RfbOutreachRenderError";
  }
}

function requireName(input: RfbOutreachRenderInput): string {
  const raw = String(input.producerName ?? "").trim();
  if (!raw) throw new RfbOutreachRenderError("producer name is empty");
  return cleanOutreachProviderName(raw);
}

function requireProfileUrl(input: RfbOutreachRenderInput): void {
  if (!isValidRfbProfileUrl(input.profileUrl)) {
    throw new RfbOutreachRenderError(`profile URL fails validate_profile_url: ${JSON.stringify(input.profileUrl)}`);
  }
}

/**
 * Text H — first contact. Paragraphs are joined by a blank line; the signature
 * block is the only paragraph with line breaks. Throws RfbOutreachRenderError
 * instead of sending something the template does not describe: an empty
 * producer name, an invalid profile URL, or a producer count too small.
 */
export function renderRfbOutreachEmail(input: RfbOutreachRenderInput): RfbOutreachRendered {
  const navn = requireName(input);
  requireProfileUrl(input);
  const count = rfbOutreachProducerCountLabel(input.producerCountTotal);
  if (!count) {
    throw new RfbOutreachRenderError(`producer count ${input.producerCountTotal} too small for {N}`);
  }
  const firstName = typeof input.contactFirstName === "string" ? input.contactFirstName.trim() : "";
  const variant = rfbOutreachSubjectVariant(input.agentId);
  const eierUrl = rfbOwnerUrl(input.agentId);

  const paragraphs = [
    firstName ? `Hei ${firstName},` : "Hei,",
    `Jeg har ett spørsmål om ${navn}: stemmer varene som står på siden deres? Jeg heter Daniel Fredriksen og driver Rett fra Bonden, en gratis oversikt over mer enn ${count} norske matprodusenter. Dere står der allerede:`,
    input.profileUrl,
    `Varene er det vi oftest tar feil av, så et kort svar hjelper mye. Er noe annet feil, kan dere bare svare på denne e-posten, så retter jeg det.`,
    `Grunnen til at jeg gjør dette, er at mange nå spør ChatGPT og lignende tjenester om hvor de kan kjøpe lokal mat. Små produsenter kommer ofte ikke med i svarene, fordi informasjonen om dem er spredt eller gammel. Rett fra Bonden samler den og setter den opp slik at disse tjenestene kan lese den. Det erstatter ikke nettsiden deres, men gjør at dere blir funnet der folk nå spør.`,
    `Det koster ingenting å stå der, og dere binder dere ikke til noe. Vil dere styre siden selv, kan dere ta den over her, uten passord: ${eierUrl}`,
    `Vil dere ikke være med, svarer dere bare «fjern», så tar jeg siden ned innen et døgn.`,
    `Vennlig hilsen\nDaniel Fredriksen\nRett fra Bonden\n${RFB_OUTREACH_SIGNATURE_PHONE}`,
    RFB_OUTREACH_PRIVACY_LINE,
  ];

  return {
    template: RFB_OUTREACH_TEMPLATE_ID,
    variant,
    subject: rfbOutreachSubject(variant, input.producerName),
    text: paragraphs.join("\n\n"),
  };
}

/**
 * Text I — second contact. `Re: <first subject>` when the first mail is known
 * (the caller then also sends In-Reply-To/References); otherwise a new mail
 * with subject A.
 */
export function renderRfbOutreachFollowup(input: RfbOutreachRenderInput): RfbOutreachRendered {
  const navn = requireName(input);
  requireProfileUrl(input);
  const monthPhrase = String(input.monthPhrase ?? "").trim();
  if (!monthPhrase) throw new RfbOutreachRenderError("month phrase is missing for the follow-up");
  const variant = rfbOutreachSubjectVariant(input.agentId);

  const paragraphs = [
    `Hei igjen,`,
    `Jeg skrev til dere ${monthPhrase} om ${navn} på Rett fra Bonden. Det holder med ett ord: stemmer varene som står der, ja eller nei?`,
    input.profileUrl,
    `Det er gratis å stå der. Vil dere ikke være med, svarer dere «fjern». Jeg skriver ikke igjen om dette.`,
    `Vennlig hilsen\nDaniel Fredriksen`,
    RFB_OUTREACH_PRIVACY_LINE,
  ];

  const first = typeof input.firstSubject === "string" ? input.firstSubject.trim() : "";
  return {
    template: RFB_OUTREACH_FOLLOWUP_TEMPLATE_ID,
    variant,
    subject: first ? `Re: ${first}` : rfbOutreachSubject("A", input.producerName),
    text: paragraphs.join("\n\n"),
  };
}

/**
 * Text J — thank-you reply in the producer's thread after they confirmed the
 * information or sent corrections that are verified live (CS lane). With
 * `corrected: false` (they only confirmed that all is right) the first
 * sentence is the draft's alternative.
 */
export function renderRfbThankYouV4(input: {
  agentId: string;
  profileUrl: string;
  firstName: string;
  corrected: boolean;
}): string {
  if (!isValidRfbProfileUrl(input.profileUrl)) {
    throw new RfbOutreachRenderError(`profile URL fails validate_profile_url: ${JSON.stringify(input.profileUrl)}`);
  }
  const first = input.corrected
    ? `Takk for svaret. Jeg har rettet siden, og den ser nå slik ut: ${input.profileUrl}`
    : `Takk for svaret. Da står siden slik den er: ${input.profileUrl}`;
  return [
    `Hei ${input.firstName},`,
    first,
    `Endrer noe seg, kan dere svare på denne e-posten når som helst. Vil dere heller endre siden selv, kan dere ta den over her, uten passord: ${rfbOwnerUrl(input.agentId)}`,
    `Vennlig hilsen\nDaniel Fredriksen`,
  ].join("\n\n");
}
