/**
 * Order texts — dev-request 2026-10-30-rfb-eierportal-testrunde-1, T11
 * (punkt 5, «grensen stopper misbruk per kunde»).
 *
 * From T11 every order text (limits now; confirmation, cancellation and «I
 * dag» for `orders.*` as later slices move them here) lives in this ONE
 * module. Pure functions, no I/O and no env reads: the numbers come from the
 * configuration the caller passes in (cart-service ORDER_CAP_* readers), so a
 * text can never promise a limit the code does not enforce.
 *
 * Used only with ORDER_CAP_V2_ENABLED on. Off, the owner page and the buyer
 * notice keep their B4 texts byte for byte (page.ts ordersExplainHtml,
 * order-cap-notice.ts orderCapBuyerNotice).
 *
 * Word list (pakke A): «per dag» = from midnight to midnight, Norwegian time
 * (never «døgn»); «bestilling» in sentences.
 */

/** The limits in force (ORDER_CAP_V2_ENABLED). */
export interface OrderLimitsConfig {
  /** ORDER_CAP_OPEN_PENDING_PER_BUYER: unanswered orders one buyer may have open with one producer. */
  openPerBuyer: number;
  /** ORDER_CAP_NEW_PER_BUYER_PER_DAY: new orders one buyer may send one producer per Oslo day. */
  perBuyerPerDay: number;
  /** ORDER_CAP_PRODUCER_CEILING_PER_DAY: the platform ceiling per producer per Oslo day (all buyers). */
  producerCeilingPerDay: number;
}

/** The reason_detail of a v2 cap hit (order_cap_events.reason_detail, cap_reason on the handoff). */
export type OrderCapDetail = "platform_ceiling" | "buyer_open_cap" | "buyer_daily_cap";

// ─── Owner: «Slik fungerer bestillinger» ─────────────────────────────────────

export const OWNER_ORDER_LIMITS_HEADING = "Hvor mange bestillinger kan du få?";

/** The limit sentences, in order, with the configured numbers. */
export function ownerOrderLimitLines(cfg: OrderLimitsConfig): string[] {
  return [
    "Mange ulike kunder kan bestille fra deg samme dag.",
    `For å stoppe misbruk kan én kunde ha høyst ${cfg.openPerBuyer} ubesvarte bestillinger hos deg om gangen, og sende deg høyst ${cfg.perBuyerPerDay} nye bestillinger per dag.`,
    `Får du flere enn ${cfg.producerCeilingPerDay} bestillinger på én dag, tar vi ikke imot flere til deg resten av dagen. Kundene får da kontaktinformasjonen din i stedet.`,
    "En dag regnes fra midnatt til midnatt.",
  ];
}

/**
 * The auto-cancel sentence. «, og kunden får beskjed» only when the buyer is
 * actually told (ORDER_BUYER_RECEIPTS_ENABLED) — never a promise the
 * platform does not keep.
 */
export function ownerAutocancelLine(hours: number, buyerReceiptsOn: boolean): string {
  return `Er bestillingen fortsatt ubesvart etter ${hours} timer, blir den kansellert${buyerReceiptsOn ? ", og kunden får beskjed" : ""}.`;
}

// ─── Buyer: why this order became a contact request (pakke C) ────────────────

/**
 * The buyer's text for a v2 cap hit (ORDER_CAP_NOTICE_ENABLED only; the
 * caller decides). `n` is the limit in force; the web cart passes the token
 * «{cap}» and fills it in from the response.
 */
export function buyerOrderCapNotice(detail: OrderCapDetail, n: number | string, lang: "no" | "en" = "no"): string {
  if (lang === "en") {
    switch (detail) {
      case "platform_ceiling":
        return "The producer is not taking more orders through Rett fra Bonden today, so your order was not sent. Contact the producer directly with the details and the message below, or try again tomorrow.";
      case "buyer_open_cap":
        return `You already have ${n} unanswered orders with this producer, so this one was not sent. Wait until the producer has answered, or contact them directly with the details and the message below.`;
      default:
        return `You have sent this producer ${n} orders today, the limit per day, so this one was not sent. Contact the producer directly with the details and the message below.`;
    }
  }
  switch (detail) {
    case "platform_ceiling":
      return "Produsenten tar ikke imot flere bestillinger gjennom Rett fra Bonden i dag, så bestillingen ble ikke sendt. Ta kontakt med produsenten direkte med kontaktinformasjonen og meldingen under, eller prøv igjen i morgen.";
    case "buyer_open_cap":
      return `Du har allerede ${n} ubesvarte bestillinger hos denne produsenten, så denne ble ikke sendt. Vent til produsenten har svart, eller ta kontakt direkte med kontaktinformasjonen og meldingen under.`;
    default:
      return `Du har sendt ${n} bestillinger til denne produsenten i dag, så denne ble ikke sendt. Ta kontakt med produsenten direkte med kontaktinformasjonen og meldingen under.`;
  }
}
