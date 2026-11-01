// ─── «Nyheter og tips» — the consent text, its version and hash ─────────────
// eierportal testrunde 1, T7 (punkt 1, tekstpakke A). The question the owner
// answers in the group «Kontakt fra Rett fra Bonden» on «Mine valg», and the
// row text of comms.news, are the consent text. Every «Ja takk» stores the
// text version in owner_feature_audit.text_version (with the place it was
// answered in `placement`), so a stored yes can be read against the exact
// words the owner saw. The row text is shown only on the allowlisted «Mine
// valg» page (page.ts); the registry description of comms.news is unchanged,
// because the public «For produsenter» page reads it. Changing any of these
// strings requires a NEW
// version: news-consent's hash is pinned per version in
// src/routes/owner-features-t7.test.ts, which fails when the text changes
// under the same version.

import crypto from "crypto";

export interface OwnerNewsConsentText {
  question: string;
  body: string;
  always: string;
  yes: string;
  later: string;
  laterNote: string;
  never: string;
  /** The comms.news row text on «Mine valg» (NO; EN kept with it) — the same consent. */
  row: { no: string; en: string };
}

export const OWNER_NEWS_CONSENT_VERSION = "2026-11-01";

export const OWNER_NEWS_CONSENT_TEXT: Readonly<OwnerNewsConsentText> = Object.freeze({
  question: "Vil du ha nyheter og tips på e-post?",
  body:
    "Vi forteller om nye ting du kan bruke, og gir tips om hvordan flere kunder finner deg. Vi har ikke begynt å sende nyheter ennå. " +
    "Vi sender bare når vi har noe nyttig å fortelle, og du kan melde deg av når som helst.",
  always: "Beskjeder om bestillingene dine og viktige endringer i vilkårene får du uansett.",
  yes: "Ja takk",
  later: "Ikke nå",
  laterNote: "Svarer du «Ikke nå», får du ingen nyheter.",
  never: "Nei, ikke spør meg igjen",
  row: Object.freeze({
    no: "Nyheter om ting du kan bruke, og tips om hvordan flere kunder finner deg. Vi har ikke begynt å sende nyheter ennå. Du kan melde deg av når som helst.",
    en: "News about things you can use, and tips on how more customers find you. We have not started sending news yet. You can unsubscribe at any time.",
  }),
}) as OwnerNewsConsentText;

/** sha256 over the consent text (stable key order), hex. */
export function ownerNewsConsentHash(text: OwnerNewsConsentText = OWNER_NEWS_CONSENT_TEXT): string {
  const t = text;
  const canonical = JSON.stringify([t.question, t.body, t.always, t.yes, t.later, t.laterNote, t.never, t.row.no, t.row.en]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The confirmations after each answer (shown in the group or the row). */
export const OWNER_NEWS_ANSWER_TEXT = {
  yes: "Takk! Du får nyheter og tips på e-post. Du kan slå det av her når som helst.",
  later: "Greit. Vi spør igjen tidligst om tre måneder. Du kan slå det på her når du vil.",
  never: "Greit. Vi spør ikke igjen. Du kan slå det på her hvis du ombestemmer deg.",
} as const;

/** Under the group name «Kontakt fra Rett fra Bonden». */
export const OWNER_COMMS_GROUP_NOTE = "Dette er frivillig, og du kan endre det når som helst.";
/** Under «Varsler til deg». */
export const OWNER_NOTIFY_GROUP_NOTE =
  "Beskjeder som hører til noe du har slått på, for eksempel nye bestillinger. Du får dem så lenge det er på.";

/** «Ikke nå» rests the question this many days … */
export const OWNER_NEWS_SNOOZE_DAYS = 90;
/** … at most this many times; after the last «Ikke nå» it is never shown again. */
export const OWNER_NEWS_MAX_ROUNDS = 3;

/**
 * Where a consent answer was given (owner_feature_audit.placement).
 * T15 (dashboard «Oversikt») adds its own place here.
 */
export const OWNER_NEWS_PLACEMENTS = ["mine_valg_question", "mine_valg_row"] as const;
export type OwnerNewsPlacement = (typeof OWNER_NEWS_PLACEMENTS)[number];
/** The question in «Kontakt fra Rett fra Bonden» on «Mine valg». */
export const OWNER_NEWS_PLACEMENT_QUESTION: OwnerNewsPlacement = OWNER_NEWS_PLACEMENTS[0];
/** The comms.news row (its switch) on «Mine valg». */
export const OWNER_NEWS_PLACEMENT_ROW: OwnerNewsPlacement = OWNER_NEWS_PLACEMENTS[1];
