// ─── Gårdssalg claim: owner-facing texts (tekstpakke OA-4) ──────────────────
// A2A dev-request 2026-11-12-opplevagent-o3-eierkrav-og-innlogging, slice
// O3-1. Every string here is VERBATIM from marketing-drafts/2026-11-12-
// opplevagent-tekstpakke-oa-4.md part 1, approved by Daniel 2026-11-15
// (daniel-responses/2026-11-15-live-tekstpakke-oa-4-godkjent.md). Keys are the
// pack's own keys. Change a text only with a new approval of the pack.
//
// `claim.resend.tooMany` says «Vent en time»: it must match
// CLAIM_RATE_LIMIT_WINDOW_HOURS (1) in services/gardssalg-claim.ts, which is
// the window resendClaimLinkForToken() counts in.
//
// `{kontaktadresse}` is filled by the route with CLAIM_MANUAL_FALLBACK_EMAIL.
// Strings only — no HTML, no logic.
export const CLAIM_LINK_TEXTS = {
  "claim.invalid.heading": "Lenken virker ikke lenger",
  "claim.invalid.body": "Lenken er utløpt eller allerede brukt. Du kan få en ny.",
  "claim.invalid.button": "Send ny lenke",
  "claim.resend.done":
    "Hvis det finnes en forespørsel om å ta over denne profilen, har vi sendt en ny lenke til adressen som ble brukt. Sjekk også søppelpost.",
  "claim.resend.tooMany": "Du har bedt om mange lenker. Vent en time og prøv igjen.",
  "claim.help": "Får du ikke e-posten? Skriv til {kontaktadresse}, så hjelper vi deg.",
} as const;

export type ClaimLinkTextKey = keyof typeof CLAIM_LINK_TEXTS;

// Slice O3-2 (flag GARDSSALG_CLAIM_CONFIRM_STEP_ENABLED): VERBATIM from the
// same pack, part 2 «Eieren bekrefter med en knapp». `{produsent}` is filled
// by the route with the provider's name.
export const CLAIM_CONFIRM_TEXTS = {
  "claim.confirm.heading": "Ta over profilen til {produsent}",
  "claim.confirm.body":
    "Når du bekrefter, blir du eier av profilen. Da kan du rette opplysningene, bestemme om stedet tar imot besøk, og svare på forespørsler.",
  "claim.confirm.responsibility": "Du bekrefter at du har rett til å representere {produsent}.",
  "claim.confirm.button": "Ja, ta over profilen",
  "claim.confirm.notMe": "Dette er ikke meg",
  "claim.confirm.notMe.done": "Ingenting er endret. Du kan lukke siden.",
} as const;

// Slice O3-5: VERBATIM from the same pack, part 4 (mails behind GARDSSALG_CLAIM_MANUAL_QUEUE_RECEIPT_ENABLED).
export const MANUAL_CLAIM_TEXTS = {
  "claim.manual.receipt.page": "Vi har mottatt forespørselen din om å ta over profilen til {produsent}. Vi ser på den og svarer på e-post.",
  "claim.manual.receipt.subject": "Vi har mottatt forespørselen din — {produsent}",
  "claim.manual.receipt.body":
    "Hei,\n\nVi har mottatt forespørselen din om å ta over profilen til {produsent} på Opplevagent.\n\nVi kunne ikke bekrefte den automatisk, så vi ser på den selv. Du hører fra oss på e-post. Det kan hende vi ber om noe som viser at du representerer {produsent}.\n\nDu trenger ikke gjøre noe nå.\n\nHilsen\nOpplevagent",
  "claim.manual.reject.subject": "Om forespørselen din — {produsent}",
  "claim.manual.reject.body":
    "Hei,\n\nVi kunne ikke gi deg tilgang til profilen til {produsent} på Opplevagent ut fra opplysningene vi har.\n\nMener du det er feil, svarer du på denne e-posten og forteller hvordan du er knyttet til {produsent}. Da ser vi på det på nytt.\n\nHilsen\nOpplevagent",
} as const;

// O3-5 form labels: NOT APPROVED (no text in the pack). Shown only behind
// GARDSSALG_CLAIM_MANUAL_QUEUE_ENABLED (default off); filed as «Tillegg fra skive O3-5».
export const MANUAL_CLAIM_FORM_TEXTS_NOT_APPROVED = {
  heading: "Be om å ta over profilen",
  intro: "Vi kan ikke bekrefte automatisk at du representerer {produsent}. Send oss navnet og e-postadressen din, så vurderer vi kravet manuelt.",
  name: "Navnet ditt",
  email: "E-postadressen din",
  message: "Hvordan er du knyttet til stedet? (valgfritt)",
  button: "Send kravet",
  invalid: "Fyll inn navnet ditt og en gyldig e-postadresse.",
  failed: "Vi kunne ikke ta imot kravet nå. Prøv igjen senere, eller skriv til kontakt@opplevagent.no.",
} as const;
