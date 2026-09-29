// ─── RFB cold-outreach e-mail — the v2 template, encoded ──────────────────────
//
// dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben. Until
// this file existed the Rett fra Bonden outreach text lived ONLY in A2A SKILL
// files and was rendered by the marketing-comms-agent LLM routine at send
// time. This is the same text, as a PURE function (no I/O, no clock, no
// randomness), so the platform-side daily send (services/rfb-marketing-
// daily.ts) renders it deterministically. No new copy was written here; every
// line below is taken from the A2A files named next to it, with the later
// addendum winning on conflict (marketing-comms-agent.md Step 0: "the
// addendum wins; most-recent commit wins between two addenda").
//
// Where each part comes from (A2A repo, slookisen/A2A):
//   • Body paragraphs, the "Hei {{kontakt_fornavn|default:""}}," greeting rule
//     and the drop-line rule for an empty personal_observation —
//     scheduled-agents/marketing-comms-agent-v2-template-addendum.md
//     §"Full v2-body" + §"Templating-regler" (master: marketing-drafts/
//     outreach-email-v2-template.md). The template's own hard line wraps are
//     kept exactly as written there.
//   • ONE template for first AND second touch — marketing-comms-agent.md
//     §"Second-touch mode" (2026-07-25, dev-request 2026-07-23-second-touch-
//     same-template-social-proof).
//   • Subject A «Har vi info riktig om …?» / B «Profil-utkast for …» and the
//     50/50 split "producer_id mod 2 == 0 → A, else B" — v2-template-addendum
//     §"A/B-test-fase"; A2A marketing-v2-rollout-status.md
//     ("A: id%2==0, B: id%2==1"). agent ids are UUIDs today; the routine
//     applied the rule as the parity of the LAST HEX DIGIT of agent_id
//     (marketing-runs/2026-08-24 + 2026-08-25 daily-summary.md: «Splitt
//     basert på pariteten av siste hex-siffer i agent_id»), which is exactly
//     "id mod 2" for a hex number — and for a decimal id too.
//   • personal_observation: retired, always "" → its line is dropped —
//     scheduled-agents/marketing-comms-agent-2026-09-08-personal-observation-
//     retired-addendum.md.
//   • Signature block without the private e-mail, and the social-proof line
//     «Katalogen har i dag over N norske matprodusenter.» (no "verifiserte",
//     no visits clause; N = the producer count rounded DOWN to hundreds,
//     e.g. «over 1 700») — scheduled-agents/marketing-comms-agent-2026-09-09-
//     signatur-og-social-proof-addendum.md.
//   • Canonical profile URL + the validate_profile_url class guard (exactly
//     one "://", ^https://rettfrabonden\.com/produsent/[a-z0-9-]+$) —
//     scheduled-agents/marketing-comms-agent-canonical-url-addendum.md.
//
// Deterministic choices where the SKILL relied on the LLM's judgment (see
// renderRfbOutreachEmail's doc comment): no first-name greeting unless a
// caller passes one (the job never does → always «Hei,»); a non-hex last
// character of agent_id falls back to subject A (the template's «anbefalt»
// subject).

export const RFB_OUTREACH_TEMPLATE_ID = "rfb-outreach-v2";

export type RfbOutreachSubjectVariant = "A" | "B";

/** «producer_id mod 2 == 0 → A, ellers B», applied to the last hex digit. */
export function rfbOutreachSubjectVariant(agentId: string): RfbOutreachSubjectVariant {
  const last = String(agentId ?? "").trim().toLowerCase().slice(-1);
  if (!/^[0-9a-f]$/.test(last)) return "A";
  return parseInt(last, 16) % 2 === 0 ? "A" : "B";
}

export function rfbOutreachSubject(variant: RfbOutreachSubjectVariant, producerName: string): string {
  const name = producerName.trim();
  return variant === "A" ? `Har vi info riktig om ${name}?` : `Profil-utkast for ${name}`;
}

/** Producer count rounded DOWN to the nearest hundred (1 743 → 1 700). */
export function roundProducerCountDown(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.floor(total / 100) * 100;
}

/** 1700 → "1 700" — plain-space thousands separator, as the addendum writes it. */
export function formatProducerCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * «Katalogen har i dag over N norske matprodusenter.» — or null when the
 * count cannot support the sentence (fewer than 100 after rounding down, e.g.
 * an empty/broken table). The template has no fallback wording for that case,
 * so a caller must not send rather than invent one.
 */
export function rfbOutreachSocialProofLine(producerCountTotal: number): string | null {
  const rounded = roundProducerCountDown(producerCountTotal);
  if (rounded < 100) return null;
  return `Katalogen har i dag over ${formatProducerCount(rounded)} norske matprodusenter.`;
}

/** validate_profile_url from the canonical-url addendum, as a predicate. */
export function isValidRfbProfileUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  if (url.split("://").length - 1 !== 1) return false;
  return /^https:\/\/rettfrabonden\.com\/produsent\/[a-z0-9-]+$/.test(url);
}

export interface RfbOutreachRenderInput {
  /** Drives the A/B subject split only. */
  agentId: string;
  producerName: string;
  /** Canonical profile URL (already validated — see isValidRfbProfileUrl). */
  profileUrl: string;
  /** Raw producer count; rounded down to hundreds here. */
  producerCountTotal: number;
  /**
   * Optional first name for «Hei <fornavn>,». The SKILL only fills this "if we
   * have a first name from the website scrape"; there is no such field in the
   * database and the routine's guesses were LLM judgment, so the daily job
   * never passes one — every e-mail opens «Hei,», the SKILL's own fallback.
   */
  contactFirstName?: string | null;
}

export interface RfbOutreachRendered {
  template: typeof RFB_OUTREACH_TEMPLATE_ID;
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

/**
 * Render one RFB outreach e-mail (plain text; the CRM compose path derives the
 * HTML alternative from it exactly as it does for every compose send). Throws
 * RfbOutreachRenderError instead of sending something the template does not
 * describe: an empty producer name, an invalid profile URL, or a producer
 * count too small for the social-proof sentence.
 */
export function renderRfbOutreachEmail(input: RfbOutreachRenderInput): RfbOutreachRendered {
  const producerName = String(input.producerName ?? "").trim();
  if (!producerName) throw new RfbOutreachRenderError("producer name is empty");
  if (!isValidRfbProfileUrl(input.profileUrl)) {
    throw new RfbOutreachRenderError(`profile URL fails validate_profile_url: ${JSON.stringify(input.profileUrl)}`);
  }
  const socialProof = rfbOutreachSocialProofLine(input.producerCountTotal);
  if (!socialProof) {
    throw new RfbOutreachRenderError(`producer count ${input.producerCountTotal} too small for the social-proof line`);
  }
  const firstName = typeof input.contactFirstName === "string" ? input.contactFirstName.trim() : "";
  const variant = rfbOutreachSubjectVariant(input.agentId);

  const lines = [
    firstName ? `Hei ${firstName},` : "Hei,",
    "",
    `Jeg har laget en profil for ${producerName} som del av en åpen katalog`,
    "over norske matprodusenter. Du finner den her:",
    "",
    input.profileUrl,
    "",
    // {{personal_observation|drop_line_if_empty}} — retired 2026-09-08, always
    // empty, so its line (and the blank line after it) is dropped.
    socialProof,
    "",
    "Bakgrunnen: AI-assistenter (typ ChatGPT, Claude) svarer i økende",
    "grad direkte på «hvor får jeg lokal honning i Asker»-spørsmål.",
    "Norske produsenter forsvinner ofte i svarene fordi info-en deres",
    "ligger spredt. Vi samler det på ett sted, og holder profilene",
    "oppdaterte.",
    "",
    "Det koster ingenting og dere er ikke bundet til noe. Jeg ville bare",
    "sjekke at info stemmer, og at dere er OK med å være synlige der.",
    "",
    "Si fra om noe må endres — eller om dere helst fjernes. Begge deler",
    "ordnes innen 24 timer.",
    "",
    "Mvh,",
    "Daniel Fredriksen",
    "Rett fra Bonden",
    "kontakt@rettfrabonden.com",
    "rettfrabonden.com",
    "",
    "(Svar «fjern» så slettes profilen automatisk.)",
  ];

  return {
    template: RFB_OUTREACH_TEMPLATE_ID,
    variant,
    subject: rfbOutreachSubject(variant, producerName),
    text: lines.join("\n"),
  };
}
