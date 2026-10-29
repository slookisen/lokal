// ─── «Mine valg» — the owner feature registry ────────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2a. One typed entry
// per owner choice in «Vedlegg A — katalog v1» (49 entries, same groups and
// order). Everything an owner can notice (visibility, outbound mail, automatic
// writes, duties) gets an entry here; the lookup (./resolve.ts) and the owner
// API (routes/owner-features.ts) read only this list.
//
// Binding default rules (spec «Prinsipper for standardvalg»):
//   1. a duty for the owner is OFF until the owner turns it on;
//   2. what keeps today's visibility is ON;
//   3. sharing / marketing mention is OFF until the owner says yes (consent);
//   5. notices that belong to a duty are LOCKED ON while the duty applies;
//   6. new functions arrive OFF, and a changed default never changes an
//      explicit owner choice (only explicit choices are stored);
//   7. unclaimed profiles follow the `unclaimed` default (null = «Gjelder ikke»).
//
// Status in S2a: `live` only for orders.enabled (adapter ↔
// agents.order_notifications_opt_in), orders.reminder + notify.order_email
// (locked on while orders.enabled is on) and the two guarantees. Every other
// entry is `coming_soon`; the slice that builds its enforcement flips it.
// S2e (side v2, «Én bryter, ett sted»): the /eier «Bestillinger» and pause
// cards move into «Mine valg», so visibility.profile (the owner pause),
// orders.email (the confirmed order address) and comms.news (the first-login
// consent, shown in its row) are `live` too. A `coming_soon` entry is shown
// only in the page's «Planlagt» box, with no value.

import { readOrderNotificationsOptIn, writeOrderNotificationsOptIn, readOrderNotificationEmailOverride } from "../services/order-opt-in";
import { readOwnerProfileVisible, writeOwnerProfileVisible } from "../services/owner-pause-store";
import { GARDSSALG_BOOKING_ENABLED_ADAPTER, GARDSSALG_PROFILE_VISIBLE_ADAPTER } from "./gardssalg-adapters";

export const OWNER_FEATURE_KEYS = [
  // Hvem kan finne deg
  "visibility.profile",
  "visibility.ai_assistants",
  "visibility.search_engines",
  "visibility.shopping_feeds",
  "visibility.english",
  "visibility.leaderboard",
  // Kontaktinformasjon
  "contact.phone",
  "contact.email_mode",
  "contact.address",
  // Produkter og priser
  "products.import",
  "products.weekly_sync",
  "products.show_prices",
  "products.stock_check",
  // Bestillinger
  "orders.enabled",
  "orders.email",
  "orders.pause",
  "orders.pickup_times",
  "orders.buyer_ai",
  "orders.messages",
  "orders.auto_close",
  "orders.reminder",
  "orders.gardssalg",
  "orders.daily_cap",
  "orders.min_value",
  "orders.lead_time",
  "orders.delivery",
  "orders.auto_confirm",
  // Betaling
  "payments.prepay",
  "payments.pay_at_pickup",
  // Varsler til deg
  "notify.order_email",
  "notify.order_sms",
  "notify.report",
  "notify.milestones",
  "notify.changes",
  // Hjelp med å holde profilen oppdatert
  "auto.guarantee",
  "auto.updates",
  "auto.debio",
  "auto.categories",
  "auto.affiliations",
  "auto.photos",
  // Statistikk og offentlige tall
  "stats.public_counts",
  "stats.public_search_terms",
  "stats.public_trust",
  "stats.share_partner",
  // Kontakt fra Rett fra Bonden
  "comms.unsubscribe",
  "comms.news",
  "comms.beta",
  "comms.featured",
  // Koblinger
  "connect.own_ai",
] as const;

/**
 * Opplevagent gårdssalg (drink producers), dev-request 2026-10-22-opplevagent-
 * mine-valg-gardssalg «Vedlegg A — katalog for gårdssalg» (34 entries, same
 * groups and order). Keys shared with RFB keep the RFB name; the entry itself
 * is the gårdssalg one (own texts, defaults, adapters and surfaces).
 */
export const GARDSSALG_OWNER_FEATURE_KEYS = [
  // Hvem kan finne deg
  "visibility.profile",
  "visibility.ai_assistants",
  "visibility.search_engines",
  "visibility.english",
  "visibility.exact_location",
  // Kontaktinformasjon
  "contact.phone",
  "contact.email_mode",
  "contact.address",
  "contact.booking_email",
  // Besøk og booking
  "booking.enabled",
  "booking.pause",
  "booking.ai_booking",
  "booking.within_hours",
  "booking.reminder",
  "booking.attendance",
  "visit.tasting",
  "booking.expiry",
  "booking.lead_time",
  "booking.party_size",
  // Innhold og oppdatering
  "content.guarantee",
  "content.auto_updates",
  "content.photos",
  // Varsler til deg
  "notify.booking_email",
  "notify.booking_sms",
  "notify.report",
  "notify.milestones",
  "notify.changes",
  // Statistikk og offentlige tall
  "stats.public_counts",
  "stats.share_partner",
  // Kontakt fra Opplevagent
  "comms.unsubscribe",
  "comms.news",
  "comms.beta",
  "comms.featured",
  "tools.badge",
] as const;

export type RfbOwnerFeatureKey = (typeof OWNER_FEATURE_KEYS)[number];
export type GardssalgOwnerFeatureKey = (typeof GARDSSALG_OWNER_FEATURE_KEYS)[number];
export type OwnerFeatureKey = RfbOwnerFeatureKey | GardssalgOwnerFeatureKey;

export type OwnerFeatureGroup =
  | "visibility" | "contact" | "products" | "orders" | "payments"
  | "notify" | "auto" | "stats" | "comms" | "connect"
  | "booking" | "content";

export type OwnerFeatureType = "switch" | "choice" | "number" | "date" | "email" | "action" | "guarantee" | "locked";
export type OwnerFeatureStatus = "live" | "beta" | "coming_soon";
export type OwnerFeatureVertical = "rfb" | "gardssalg";
export type OwnerFeatureValue = boolean | string | number | null;

export interface LocalizedText {
  no: string;
  en: string;
}

/**
 * Non-key requirements. verifiedOwner = customerRuleSql (claimed_at OR a
 * verified agent_claims row); isVerifiedBadge = agents.is_verified = 1 (the
 * strict real-order gate). stripeActive / drinkProducer are not wired in S2a
 * and evaluate as unmet — only coming_soon entries use them.
 * Gårdssalg (O1a): the subject loader (gardssalg-adapters.ts) fills these per
 * row — bookingRequestEmail = the row has an address booking requests can be
 * sent to (hasBookingRequestEmail, the admin lever's rule);
 * noBookingAdminBrake = Opplevagent has not stopped booking for the row;
 * visibilityOwnerControlled = the row is visible or on the owner's own pause
 * (not «fjern», not an admin quality hide).
 */
export type OwnerFeatureCondition =
  | "verifiedOwner" | "isVerifiedBadge" | "stripeActive" | "drinkProducer"
  | "bookingRequestEmail" | "noBookingAdminBrake" | "visibilityOwnerControlled";
export type OwnerFeatureRequirement = OwnerFeatureKey | OwnerFeatureCondition;

/**
 * Surfaces an entry affects («Testkrav og utrulling»): the CI matrix and the
 * prod switch probe are generated from this list. listing_html = list pages
 * that carry a profile's fields (front-page cards, city/fylke JSON-LD).
 * owner_portal = something shown to the owner in the /eier portal (B2: the
 * stock-check banner).
 */
export type OwnerFeatureSurface =
  | "profile_html" | "json_ld" | "listing_html" | "mcp_search" | "mcp_info" | "rest_card" | "vcard"
  | "acp_feed" | "sitemap" | "llms" | "a2a" | "leaderboard" | "order_gate"
  | "booking_gate"
  | "owner_portal"
  | `email:${string}` | `job:${string}`;

/**
 * Storage adapter: the entry lives in an existing column instead of
 * owner_feature_settings. The column stays the source of truth.
 */
export interface OwnerFeatureStorageAdapter {
  /** Human-readable target, e.g. "agents.order_notifications_opt_in". */
  column: string;
  /** Current value; null = the subject row does not exist. */
  read(db: any, subjectId: string): OwnerFeatureValue;
  /**
   * Returns true when written, false when no row was written, or
   * { blocked } when the column's own gate refused the value (gårdssalg
   * booking_live: an admin brake set after the resolver checked — answered
   * as a 409 like any other block).
   */
  write(db: any, subjectId: string, value: OwnerFeatureValue): boolean | { blocked: LocalizedText };
}

export interface OwnerFeatureEntry {
  key: string;
  group: OwnerFeatureGroup;
  label: LocalizedText;
  description: LocalizedText;
  type: OwnerFeatureType;
  /** `choice` only. */
  options?: Array<{ value: string; label: LocalizedText }>;
  /** `number` only. */
  min?: number;
  max?: number;
  /** `number`/`date`/`email`: null is an allowed value («Ingen» / profile default). */
  nullable?: boolean;
  /** Per segment. null = «Gjelder ikke» for that segment. */
  default: { owner: OwnerFeatureValue; unclaimed: OwnerFeatureValue };
  /** All must hold before the entry can take a non-off value. */
  requires: OwnerFeatureRequirement[];
  /**
   * Conditions checked only when the owner switches the entry ON (a stored
   * on value is still shown as on). Gårdssalg booking.enabled: the admin
   * brake and the booking-request address — the same gate the portal and
   * the admin lever use, so an attempt is refused (409) with its reason.
   */
  enableRequires?: OwnerFeatureCondition[];
  /** `locked` type: locked ON while this key is on, otherwise off. */
  lockedWhen?: OwnerFeatureKey;
  /** Locked ON unless this key is on; when it is on, the owner chooses. */
  lockOnUnless?: OwnerFeatureKey;
  /** Global emergency brake: env name; "1"/"true" forces the entry off for everyone. */
  killSwitch?: string;
  status: OwnerFeatureStatus;
  /** Sharing / marketing mention — off until the owner says yes. */
  consent: boolean;
  /** Triggers e-mail or other outbound contact (L4 / outreach rules apply). */
  outward: boolean;
  confirmOn?: LocalizedText;
  confirmOff?: LocalizedText;
  /** Shown under «Flere valg». */
  advanced: boolean;
  verticals: OwnerFeatureVertical[];
  /** Date the entry was registered / went live (drives the «Nytt» badge). */
  since: string;
  /** The dev-request that owns the function. */
  devRequest: string;
  surfaces: OwnerFeatureSurface[];
  storage?: OwnerFeatureStorageAdapter;
  /**
   * S2e: the value is changed only through a confirmation link mailed to the
   * new value (orders.email, S1b punkt 7) — never by a direct owner write.
   * The resolver reports it as not directly changeable (block
   * `confirm_by_email`); the page offers the confirmation form instead.
   */
  confirmByEmail?: boolean;
}

export const OWNER_FEATURE_GROUPS: Array<{ key: OwnerFeatureGroup; label: LocalizedText }> = [
  { key: "visibility", label: { no: "Hvem kan finne deg", en: "Who can find you" } },
  { key: "contact", label: { no: "Kontaktinformasjon", en: "Contact information" } },
  { key: "products", label: { no: "Produkter og priser", en: "Products and prices" } },
  { key: "orders", label: { no: "Bestillinger", en: "Orders" } },
  { key: "payments", label: { no: "Betaling", en: "Payment" } },
  { key: "notify", label: { no: "Varsler til deg", en: "Notifications to you" } },
  { key: "auto", label: { no: "Hjelp med å holde profilen oppdatert", en: "Help keeping your profile up to date" } },
  { key: "stats", label: { no: "Statistikk og offentlige tall", en: "Statistics and public numbers" } },
  { key: "comms", label: { no: "Kontakt fra Rett fra Bonden", en: "Contact from Rett fra Bonden" } },
  { key: "connect", label: { no: "Koblinger", en: "Connections" } },
];

const DR = "2026-10-22-rfb-mine-valg-eierbrytere";
const SINCE = "2026-10-27";
const RFB: OwnerFeatureVertical[] = ["rfb"];

/** Shared fields every entry gets unless it says otherwise. */
function entry(
  e: Omit<OwnerFeatureEntry, "requires" | "status" | "consent" | "outward" | "advanced" | "verticals" | "since" | "devRequest"> &
    Partial<Pick<OwnerFeatureEntry, "requires" | "status" | "consent" | "outward" | "advanced" | "verticals" | "since" | "devRequest">>,
): OwnerFeatureEntry {
  return {
    requires: [],
    status: "coming_soon",
    consent: false,
    outward: false,
    advanced: false,
    verticals: RFB,
    since: SINCE,
    devRequest: DR,
    ...e,
  };
}

const t = (no: string, en: string): LocalizedText => ({ no, en });

const ORDERS_ENABLED_ADAPTER: OwnerFeatureStorageAdapter = {
  column: "agents.order_notifications_opt_in",
  read: (db, subjectId) => readOrderNotificationsOptIn(db, subjectId),
  write: (db, subjectId, value) => writeOrderNotificationsOptIn(db, subjectId, value === true),
};

/**
 * S2c-2: «Profilen er synlig» is the owner pause (S1b punkt 6) — one truth,
 * the owner_profile_pause row (services/owner-pause-store.ts).
 */
const PROFILE_VISIBLE_ADAPTER: OwnerFeatureStorageAdapter = {
  column: "owner_profile_pause",
  read: (db, subjectId) => readOwnerProfileVisible(db, subjectId),
  write: (db, subjectId, value) => writeOwnerProfileVisible(db, subjectId, value === true),
};

/**
 * S2e: orders.email reads the confirmed order address
 * (agents.order_notification_email; null = the profile e-mail). It is only
 * ever written by the confirmation flow in routes/owner-portal.ts
 * (confirmOwnerOrderEmailChange), so the adapter's write refuses.
 */
const ORDER_EMAIL_ADAPTER: OwnerFeatureStorageAdapter = {
  column: "agents.order_notification_email",
  read: (db, subjectId) => readOrderNotificationEmailOverride(db, subjectId),
  write: () => false,
};

/** Public profile, structured data and AI read surfaces of a profile field. */
const PROFILE_FIELD_SURFACES: OwnerFeatureSurface[] = ["profile_html", "json_ld", "listing_html", "mcp_search", "mcp_info", "rest_card", "vcard", "a2a"];

export const OWNER_FEATURE_REGISTRY: OwnerFeatureEntry[] = [
  // ── Hvem kan finne deg ──────────────────────────────────────────────────
  entry({
    key: "visibility.profile", group: "visibility", type: "switch",
    label: t("Profilen er synlig", "Profile is visible"),
    description: t(
      "Når denne er av, er profilen borte fra søk, lister, AI-assistenter, feeder og kart. Profilsiden viser «Midlertidig pause».",
      "When off, the profile is removed from search, lists, AI assistants, feeds and maps. The profile page shows “Temporarily paused”.",
    ),
    default: { owner: true, unclaimed: true },
    confirmOff: t("Profilen blir borte fra søk og AI-assistenter til du slår den på igjen.", "Your profile disappears from search and AI assistants until you switch it back on."),
    // S2c-2: + listing_html (front page / city pages), a2a (agent/info, A2A
    // search) and leaderboard — the shared predicate removes it there too.
    surfaces: ["profile_html", "json_ld", "listing_html", "mcp_search", "mcp_info", "rest_card", "vcard", "acp_feed", "sitemap", "llms", "a2a", "leaderboard"],
    storage: PROFILE_VISIBLE_ADAPTER,
    // S2e: the /eier pause card moved here («Én bryter, ett sted»).
    status: "live",
    since: "2026-10-28",
  }),
  entry({
    key: "visibility.ai_assistants", group: "visibility", type: "switch",
    label: t("Synlig for AI-assistenter", "Visible to AI assistants"),
    description: t("AI-assistenter som ChatGPT og Claude kan finne og anbefale deg.", "AI assistants such as ChatGPT and Claude can find and recommend you."),
    default: { owner: true, unclaimed: true },
    requires: ["visibility.profile"],
    confirmOff: t("AI-assistenter vil ikke lenger kunne anbefale deg.", "AI assistants will no longer be able to recommend you."),
    surfaces: ["mcp_search", "mcp_info", "llms", "a2a"],
  }),
  entry({
    key: "visibility.search_engines", group: "visibility", type: "switch",
    label: t("Synlig i Google og Bing", "Visible in Google and Bing"),
    description: t("Søkemotorer kan vise profilsiden din i søkeresultater.", "Search engines can show your profile page in search results."),
    default: { owner: true, unclaimed: true },
    requires: ["visibility.profile"],
    surfaces: ["profile_html", "sitemap"],
  }),
  entry({
    key: "visibility.shopping_feeds", group: "visibility", type: "switch",
    label: t("Produktene mine i AI-handel", "My products in AI shopping"),
    description: t("Produktene dine tas med i produktfeeder for AI-handel.", "Your products are included in product feeds for AI shopping."),
    default: { owner: true, unclaimed: true },
    requires: ["visibility.profile"],
    devRequest: "2026-09-08-produktfeed-gmc-acp-og-vipps-ucp",
    surfaces: ["acp_feed"],
  }),
  entry({
    key: "visibility.english", group: "visibility", type: "switch",
    label: t("Profil på engelsk", "Profile in English"),
    description: t("Profilen vises også på engelsk (maskinoversatt). Du kan rette teksten selv.", "Your profile is also shown in English (machine-translated). You can correct the text yourself."),
    default: { owner: true, unclaimed: true },
    requires: ["visibility.profile"],
    surfaces: ["profile_html", "json_ld", "sitemap"],
  }),
  entry({
    key: "visibility.leaderboard", group: "visibility", type: "switch",
    label: t("Vis meg på topplister", "Show me on leaderboards"),
    description: t("Profilen kan vises på topplister over produsenter.", "Your profile can appear on producer leaderboards."),
    default: { owner: true, unclaimed: true },
    requires: ["visibility.profile"],
    advanced: true,
    surfaces: ["leaderboard"],
  }),

  // ── Kontaktinformasjon ──────────────────────────────────────────────────
  entry({
    key: "contact.phone", group: "contact", type: "switch",
    label: t("Vis telefonnummer", "Show phone number"),
    description: t("Telefonnummeret ditt vises på profilen og for AI-assistenter.", "Your phone number is shown on your profile and to AI assistants."),
    default: { owner: true, unclaimed: true },
    surfaces: PROFILE_FIELD_SURFACES,
  }),
  entry({
    key: "contact.email_mode", group: "contact", type: "choice",
    label: t("E-postadressen din", "Your e-mail address"),
    description: t("Hvordan e-postadressen din vises for besøkende og AI-assistenter.", "How your e-mail address is shown to visitors and AI assistants."),
    options: [
      { value: "show", label: t("Vis e-post", "Show e-mail") },
      { value: "protected", label: t("Skjermet mot innhøsting", "Protected against harvesting") },
      { value: "hidden", label: t("Ikke vis e-post", "Do not show e-mail") },
    ],
    default: { owner: "show", unclaimed: "show" },
    devRequest: "2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting",
    surfaces: PROFILE_FIELD_SURFACES,
  }),
  entry({
    key: "contact.address", group: "contact", type: "choice",
    label: t("Adresse", "Address"),
    description: t("Hvor mye av adressen din som vises.", "How much of your address is shown."),
    options: [
      { value: "full", label: t("Full adresse og kartnål", "Full address and map pin") },
      { value: "place", label: t("Bare sted", "Place only") },
    ],
    default: { owner: "full", unclaimed: "full" },
    surfaces: PROFILE_FIELD_SURFACES,
  }),

  // ── Produkter og priser ─────────────────────────────────────────────────
  entry({
    key: "products.import", group: "products", type: "action",
    label: t("Hent produkter fra nettsiden min", "Import products from my website"),
    description: t("Henter produktene fra nettsiden din som forslag du godkjenner.", "Fetches the products from your website as suggestions you approve."),
    default: { owner: null, unclaimed: null },
    devRequest: "2026-10-21-rfb-produktimport-fra-egen-nettside",
    surfaces: ["job:product_import"],
  }),
  entry({
    key: "products.weekly_sync", group: "products", type: "switch",
    label: t("Hold produktene oppdatert fra nettsiden", "Keep products updated from my website"),
    description: t("Produktene sjekkes mot nettsiden din hver uke.", "Your products are checked against your website every week."),
    default: { owner: false, unclaimed: false },
    devRequest: "2026-10-21-rfb-produktimport-fra-egen-nettside",
    surfaces: ["job:product_weekly_sync"],
  }),
  entry({
    key: "products.show_prices", group: "products", type: "switch",
    label: t("Vis priser", "Show prices"),
    description: t("Prisene dine vises på profilen, for AI-assistenter og i produktfeeder.", "Your prices are shown on your profile, to AI assistants and in product feeds."),
    default: { owner: true, unclaimed: true },
    surfaces: ["profile_html", "json_ld", "listing_html", "mcp_search", "mcp_info", "rest_card", "vcard", "acp_feed", "a2a"],
  }),
  // B2 (dev-request 2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier):
  // live. Default «på» for owners; `requires` orders.enabled, so it has no
  // effect (and reads off) while orders are off. Read by
  // services/stock-check-reminder.ts stockCheckOn() — the e-mail job
  // (behind STOCK_CHECK_EMAIL_ENABLED) and the /eier portal banner (behind
  // OWNER_ORDERABILITY_PORTAL_ENABLED).
  entry({
    key: "products.stock_check", group: "products", type: "switch",
    label: t("Minn meg på å bekrefte lagerstatus", "Remind me to confirm stock"),
    description: t(
      "Vi sier fra før lagerstatusen på en vare går ut, slik at kundene fortsatt kan bestille den. Du får høyst én e-post hver 14. dag.",
      "We let you know before the stock status of an item expires, so customers can still order it. You get at most one e-mail every 14 days.",
    ),
    default: { owner: true, unclaimed: null },
    requires: ["orders.enabled"],
    outward: true,
    status: "live",
    since: "2026-10-29",
    devRequest: "2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier",
    surfaces: ["email:stock_check", "job:stock_check", "owner_portal"],
  }),

  // ── Bestillinger ────────────────────────────────────────────────────────
  entry({
    key: "orders.enabled", group: "orders", type: "switch",
    label: t("Ta imot bestillinger", "Accept orders"),
    description: t(
      "Kunder og AI-assistenter kan sende deg bestillinger på henting. Uten denne får kunden kontaktinformasjonen din i stedet.",
      "Customers and AI assistants can send you pickup orders. Without it, the customer gets your contact details instead.",
    ),
    default: { owner: false, unclaimed: false },
    requires: ["verifiedOwner", "isVerifiedBadge"],
    confirmOn: t(
      "Du får bestillinger på e-post og må svare kunden. Du kan slå det av når som helst.",
      "You will receive orders by e-mail and must reply to the customer. You can switch it off at any time.",
    ),
    status: "live",
    devRequest: "2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt",
    surfaces: ["order_gate", "email:order_notification"],
    storage: ORDERS_ENABLED_ADAPTER,
  }),
  entry({
    key: "orders.email", group: "orders", type: "email",
    label: t("Bestillinger sendes til", "Orders are sent to"),
    description: t(
      "E-postadressen bestillingene går til. Standard er profilens e-post. En ny adresse gjelder når du har klikket lenken vi sender dit.",
      "The e-mail address orders go to. Default is the profile e-mail. A new address applies once you have clicked the link we send there.",
    ),
    nullable: true,
    default: { owner: null, unclaimed: null },
    requires: ["orders.enabled"],
    // S2e: the order-address form from the /eier «Bestillinger» card (S1b punkt 7).
    status: "live",
    since: "2026-10-28",
    outward: true,
    surfaces: ["email:order_notification"],
    storage: ORDER_EMAIL_ADAPTER,
    confirmByEmail: true,
  }),
  entry({
    key: "orders.pause", group: "orders", type: "switch",
    label: t("Ferie: ta ikke imot nye bestillinger", "Holiday: do not accept new orders"),
    description: t("Nye bestillinger stoppes mens du er borte. Profilen er fortsatt synlig.", "New orders are stopped while you are away. Your profile stays visible."),
    default: { owner: false, unclaimed: null },
    requires: ["orders.enabled"],
    surfaces: ["order_gate"],
  }),
  entry({
    key: "orders.pickup_times", group: "orders", type: "choice",
    label: t("Hentetid", "Pickup time"),
    description: t("Hvordan hentetid avtales med kunden.", "How the pickup time is agreed with the customer."),
    options: [
      { value: "per_order", label: t("Avtales per bestilling", "Agreed per order") },
      { value: "fixed", label: t("Faste hentetider", "Fixed pickup times") },
    ],
    default: { owner: "per_order", unclaimed: null },
    requires: ["orders.enabled"],
    devRequest: "2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent",
    surfaces: ["order_gate", "email:order_notification"],
  }),
  entry({
    key: "orders.buyer_ai", group: "orders", type: "switch",
    label: t("Kjøperens AI-assistent kan endre ordren", "The buyer's AI assistant can change the order"),
    description: t("Kjøperens AI-assistent kan endre eller avbestille en bestilling du ikke har bekreftet.", "The buyer's AI assistant can change or cancel an order you have not confirmed."),
    default: { owner: true, unclaimed: null },
    requires: ["orders.enabled"],
    devRequest: "2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent",
    surfaces: ["order_gate"],
  }),
  entry({
    key: "orders.messages", group: "orders", type: "switch",
    label: t("Meldinger fra kjøper", "Messages from the buyer"),
    description: t("Kjøperen kan sende deg meldinger om en bestilling.", "The buyer can send you messages about an order."),
    default: { owner: true, unclaimed: null },
    requires: ["orders.enabled"],
    outward: true,
    devRequest: "2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent",
    surfaces: ["email:order_message"],
  }),
  entry({
    key: "orders.auto_close", group: "orders", type: "switch",
    label: t("Lukk ordren automatisk etter henting", "Close the order automatically after pickup"),
    description: t("Ordren lukkes av seg selv etter hentedagen.", "The order closes by itself after the pickup day."),
    default: { owner: true, unclaimed: null },
    requires: ["orders.enabled"],
    devRequest: "2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent",
    surfaces: ["job:order_auto_close"],
  }),
  entry({
    key: "orders.reminder", group: "orders", type: "locked",
    label: t("Påminnelse om ubesvarte bestillinger", "Reminder about unanswered orders"),
    description: t("Du får en påminnelse når en bestilling ikke er besvart.", "You get a reminder when an order has not been answered."),
    default: { owner: false, unclaimed: null },
    lockedWhen: "orders.enabled",
    status: "live",
    outward: true,
    surfaces: ["email:order_reminder", "job:order_followups"],
  }),
  entry({
    key: "orders.gardssalg", group: "orders", type: "switch",
    label: t("Ta imot besøk (gårdssalg)", "Accept visits (farm sales)"),
    description: t("Besøkende kan be om å komme på gårdssalg. Gjelder drikkeprodusenter.", "Visitors can ask to come for a farm sale. Applies to drink producers."),
    default: { owner: false, unclaimed: false },
    requires: ["verifiedOwner", "drinkProducer"],
    devRequest: "2026-10-22-opplevagent-mine-valg-gardssalg",
    surfaces: ["order_gate"],
  }),
  entry({
    key: "orders.daily_cap", group: "orders", type: "number",
    label: t("Maks nye bestillinger per dag", "Max new orders per day"),
    description: t("Flere bestillinger enn dette samme dag blir ikke tatt imot.", "More orders than this on the same day are not accepted."),
    min: 1, max: 1000,
    default: { owner: 10, unclaimed: null },
    requires: ["orders.enabled"],
    advanced: true,
    surfaces: ["order_gate"],
  }),
  entry({
    key: "orders.min_value", group: "orders", type: "number",
    label: t("Minstebeløp per bestilling", "Minimum amount per order"),
    description: t("Bestillinger under dette beløpet (kr) blir ikke tatt imot.", "Orders below this amount (NOK) are not accepted."),
    min: 0, max: 100000, nullable: true,
    default: { owner: null, unclaimed: null },
    requires: ["orders.enabled"],
    advanced: true,
    surfaces: ["order_gate"],
  }),
  entry({
    key: "orders.lead_time", group: "orders", type: "choice",
    label: t("Varsel før henting", "Notice before pickup"),
    description: t("Hvor tidlig kunden må bestille før henting.", "How early the customer must order before pickup."),
    options: [
      { value: "same_day", label: t("Samme dag", "Same day") },
      { value: "one_day", label: t("Dagen før", "The day before") },
      { value: "two_days", label: t("To dager før", "Two days before") },
    ],
    default: { owner: "same_day", unclaimed: null },
    requires: ["orders.enabled"],
    advanced: true,
    surfaces: ["order_gate"],
  }),
  entry({
    key: "orders.delivery", group: "orders", type: "switch",
    label: t("Tilby levering", "Offer delivery"),
    description: t("Kunden kan be om levering i stedet for henting.", "The customer can ask for delivery instead of pickup."),
    default: { owner: false, unclaimed: null },
    requires: ["orders.enabled"],
    advanced: true,
    surfaces: ["order_gate"],
  }),
  entry({
    key: "orders.auto_confirm", group: "orders", type: "switch",
    label: t("Bekreft bestillinger automatisk", "Confirm orders automatically"),
    description: t("Bestillinger bekreftes til kunden uten at du trykker.", "Orders are confirmed to the customer without you pressing anything."),
    default: { owner: false, unclaimed: null },
    requires: ["orders.enabled"],
    advanced: true,
    outward: true,
    confirmOn: t("Kunden får bekreftelse med en gang. Du må kunne levere det som bestilles.", "The customer gets a confirmation right away. You must be able to supply what is ordered."),
    surfaces: ["order_gate", "email:order_confirmation"],
  }),

  // ── Betaling ────────────────────────────────────────────────────────────
  entry({
    key: "payments.prepay", group: "payments", type: "switch",
    label: t("Ta imot forhåndsbetaling", "Accept prepayment"),
    description: t("Kunden kan betale på forhånd med kort.", "The customer can pay in advance by card."),
    default: { owner: false, unclaimed: null },
    requires: ["orders.enabled", "stripeActive"],
    confirmOn: t("Kunden betaler på forhånd. Du må levere eller refundere.", "The customer pays in advance. You must deliver or refund."),
    devRequest: "2026-10-09-rfb-forhandsbetaling-stripe-connect",
    surfaces: ["order_gate"],
  }),
  entry({
    key: "payments.pay_at_pickup", group: "payments", type: "switch",
    label: t("Tillat betaling ved henting", "Allow payment at pickup"),
    description: t("Kunden kan betale når varene hentes.", "The customer can pay when the goods are picked up."),
    default: { owner: true, unclaimed: null },
    requires: ["orders.enabled"],
    lockOnUnless: "payments.prepay",
    surfaces: ["order_gate"],
  }),

  // ── Varsler til deg ─────────────────────────────────────────────────────
  entry({
    key: "notify.order_email", group: "notify", type: "locked",
    label: t("Ordrevarsel på e-post", "Order notification by e-mail"),
    description: t("Hver ny bestilling sendes til deg på e-post.", "Every new order is sent to you by e-mail."),
    default: { owner: false, unclaimed: null },
    lockedWhen: "orders.enabled",
    status: "live",
    outward: true,
    surfaces: ["email:order_notification"],
  }),
  entry({
    key: "notify.order_sms", group: "notify", type: "switch",
    label: t("SMS ved ny bestilling", "Text message on new order"),
    description: t("Du får en SMS når en ny bestilling kommer.", "You get a text message when a new order arrives."),
    default: { owner: false, unclaimed: null },
    requires: ["orders.enabled"],
    outward: true,
    devRequest: "2026-07-13-pilot-ordre-loop",
    surfaces: ["job:order_sms"],
  }),
  entry({
    key: "notify.report", group: "notify", type: "choice",
    label: t("Rapport om profilen din", "Report about your profile"),
    description: t("Visninger, med i AI-svar og klikk, sendt på e-post.", "Views, AI-answer mentions and clicks, sent by e-mail."),
    options: [
      { value: "monthly", label: t("Månedlig", "Monthly") },
      { value: "quarterly", label: t("Hvert kvartal", "Quarterly") },
      { value: "off", label: t("Aldri", "Never") },
    ],
    default: { owner: "monthly", unclaimed: "monthly" },
    outward: true,
    surfaces: ["email:owner_monthly_report"],
  }),
  entry({
    key: "notify.milestones", group: "notify", type: "switch",
    label: t("Milepæler", "Milestones"),
    description: t("En e-post når profilen når 100, 500 og 1000 visninger.", "An e-mail when your profile reaches 100, 500 and 1000 views."),
    default: { owner: true, unclaimed: true },
    outward: true,
    surfaces: ["email:owner_milestone"],
  }),
  entry({
    key: "notify.changes", group: "notify", type: "switch",
    label: t("Si fra når noe endres på profilen min", "Tell me when something changes on my profile"),
    description: t("En samlet e-post per dag når noe på profilen er endret av andre enn deg.", "One daily e-mail when something on your profile was changed by someone other than you."),
    default: { owner: true, unclaimed: true },
    outward: true,
    surfaces: ["email:owner_changes"],
  }),

  // ── Hjelp med å holde profilen oppdatert ────────────────────────────────
  entry({
    key: "auto.guarantee", group: "auto", type: "guarantee",
    label: t("Det du skriver selv, overskrives aldri", "What you write yourself is never overwritten"),
    description: t("Plattformen skriver aldri over det du har skrevet. Ny informasjon blir forslag.", "The platform never overwrites what you have written. New information becomes a suggestion."),
    default: { owner: true, unclaimed: null },
    status: "live",
    surfaces: ["job:rfb_enrichment_nightly", "job:knowledge_write"],
  }),
  entry({
    key: "auto.updates", group: "auto", type: "choice",
    label: t("Oppdatering fra nettsiden din og offentlige kilder", "Updates from your website and public sources"),
    description: t("Hva som skjer når vi finner ny informasjon om deg.", "What happens when we find new information about you."),
    options: [
      { value: "suggest", label: t("Foreslå til meg", "Suggest to me") },
      { value: "fill_empty", label: t("Fyll tomme felt selv", "Fill empty fields yourself") },
      { value: "never", label: t("Aldri", "Never") },
      { value: "automatic", label: t("Oppdateres automatisk hver natt", "Updated automatically every night") },
    ],
    default: { owner: "suggest", unclaimed: "automatic" },
    surfaces: ["job:rfb_enrichment_nightly"],
  }),
  entry({
    key: "auto.debio", group: "auto", type: "switch",
    label: t("Hent økologisk godkjenning fra Debio", "Fetch organic certification from Debio"),
    description: t("Økologisk godkjenning hentes og vises automatisk.", "Organic certification is fetched and shown automatically."),
    default: { owner: true, unclaimed: true },
    surfaces: ["job:debio_verification", "profile_html"],
  }),
  entry({
    key: "auto.categories", group: "auto", type: "switch",
    label: t("Plasser meg i salgskanaler automatisk", "Place me in sales channels automatically"),
    description: t("Vi plasserer profilen i relevante salgskanaler.", "We place your profile in relevant sales channels."),
    default: { owner: true, unclaimed: true },
    surfaces: ["job:salgskanal_matcher", "profile_html"],
  }),
  entry({
    key: "auto.affiliations", group: "auto", type: "switch",
    label: t("Vis tilknytninger", "Show affiliations"),
    description: t("Profilen viser markeder, andelslag og nettverk du er med i.", "Your profile shows markets, cooperatives and networks you belong to."),
    default: { owner: true, unclaimed: true },
    surfaces: ["profile_html", "json_ld"],
  }),
  entry({
    key: "auto.photos", group: "auto", type: "switch",
    label: t("Hent bilder fra nettsiden min", "Fetch photos from my website"),
    description: t("Bilder fra nettsiden din kan brukes på profilen.", "Photos from your website can be used on your profile."),
    default: { owner: false, unclaimed: false },
    consent: true,
    devRequest: "2026-07-04-bilder-strategi",
    surfaces: ["job:photo_import", "profile_html"],
  }),

  // ── Statistikk og offentlige tall ───────────────────────────────────────
  entry({
    key: "stats.public_counts", group: "stats", type: "switch",
    label: t("Vis besøkstall og «Med i AI-søk» på profilen", "Show visit counts and “In AI search” on the profile"),
    // S2f: the public threshold (PUBLIC_STATS_MIN_VIEWS, default 20; services/public-stats-threshold.ts).
    description: t(
      "Profilen viser hvor mange som har sett den, fra 20 sidevisninger fra mennesker siste 12 måneder. Du ser alltid dine egne tall.",
      "Your profile shows how many have seen it, from 20 page views by people in the last 12 months. You always see your own numbers.",
    ),
    default: { owner: true, unclaimed: true },
    surfaces: ["profile_html"],
  }),
  entry({
    key: "stats.public_search_terms", group: "stats", type: "switch",
    label: t("Vis hva folk søker etter", "Show what people search for"),
    description: t("Profilen viser søkeord som førte folk hit.", "Your profile shows search terms that led people here."),
    default: { owner: true, unclaimed: true },
    surfaces: ["profile_html"],
  }),
  entry({
    key: "stats.public_trust", group: "stats", type: "switch",
    label: t("Vis tillitsscore offentlig", "Show trust score publicly"),
    description: t("Tillitsscoren din vises på profilen og for AI-assistenter.", "Your trust score is shown on your profile and to AI assistants."),
    default: { owner: true, unclaimed: true },
    advanced: true,
    devRequest: "2026-09-03-rfb-trust-score-offentlig-visning",
    surfaces: ["profile_html", "rest_card", "vcard", "mcp_info", "a2a"],
  }),
  entry({
    key: "stats.share_partner", group: "stats", type: "switch",
    label: t("Del statistikken min med samarbeidspartnere", "Share my statistics with partners"),
    description: t("Partnere du er tilknyttet kan se statistikken din i sine rapporter.", "Partners you are affiliated with can see your statistics in their reports."),
    default: { owner: false, unclaimed: false },
    consent: true,
    outward: true,
    devRequest: "2026-10-03-partner-effektrapport-per-gaard",
    surfaces: ["email:partner_report"],
  }),

  // ── Kontakt fra Rett fra Bonden ─────────────────────────────────────────
  entry({
    key: "comms.unsubscribe", group: "comms", type: "guarantee",
    label: t("Avmelding uten å slette profilen", "Unsubscribe without deleting the profile"),
    description: t("Du kan alltid melde deg av e-post fra oss uten at profilen slettes.", "You can always unsubscribe from our e-mails without your profile being deleted."),
    default: { owner: true, unclaimed: true },
    status: "live",
    surfaces: ["email:outreach"],
  }),
  entry({
    key: "comms.news", group: "comms", type: "switch",
    label: t("Nyheter og tips", "News and tips"),
    description: t(
      "Om du vil ha nyheter og tips fra Rett fra Bonden på e-post. Vi lagrer svaret ditt med tidspunkt. Vi sender ingen nyhetsbrev automatisk.",
      "Whether you want news and tips from Rett fra Bonden by e-mail. We store your answer with the time. We send no newsletter automatically.",
    ),
    default: { owner: false, unclaimed: false },
    consent: true,
    outward: true,
    // S2e (principle 8): the first-login answer is this row's value. It is a
    // stored consent only: no code path sends a newsletter, so the entry
    // declares no surface (nothing for the matrix or the switch probe to
    // observe). The slice that builds a news mailing must declare
    // `email:newsletter` here and read featureOn(…, "comms.news") before sending.
    status: "live",
    since: "2026-10-28",
    surfaces: [],
  }),
  entry({
    key: "comms.beta", group: "comms", type: "switch",
    label: t("Prøv nye funksjoner først", "Try new features first"),
    description: t("Du får tilbud om å prøve nye funksjoner før andre.", "You are offered new features before others."),
    default: { owner: false, unclaimed: false },
    outward: true,
    surfaces: ["email:beta_invite"],
  }),
  entry({
    key: "comms.featured", group: "comms", type: "switch",
    label: t("Rett fra Bonden kan vise fram gården min", "Rett fra Bonden may feature my farm"),
    description: t("Vi kan omtale gården din i sosiale medier og nyhetsbrev.", "We may feature your farm on social media and in newsletters."),
    default: { owner: false, unclaimed: false },
    consent: true,
    outward: true,
    surfaces: ["job:social_media"],
  }),

  // ── Koblinger ───────────────────────────────────────────────────────────
  entry({
    key: "connect.own_ai", group: "connect", type: "switch",
    label: t("Koble til din egen AI-assistent", "Connect your own AI assistant"),
    description: t("Din egen AI-assistent kan lese og svare på bestillinger for deg.", "Your own AI assistant can read and answer orders for you."),
    default: { owner: false, unclaimed: null },
    requires: ["orders.enabled"],
    devRequest: "2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent",
    surfaces: ["order_gate"],
  }),
];

// ═══════════════════════════════════════════════════════════════════════════
// Opplevagent gårdssalg — dev-request 2026-10-22-opplevagent-mine-valg-
// gardssalg, «v2 for Opplevagent», slice O1a («Vedlegg A — katalog for
// gårdssalg», 34 entries). Same shape, same resolver, same page component as
// RFB; `verticals: ["gardssalg"]`. No text names Rett fra Bonden (principle 9).
//
// Status in O1a — `live` only where this slice enforces the value:
//   visibility.profile  adapter ↔ the owner pause (G1 pkt 4) — every public
//                       surface already hides a paused row (gardssalg-
//                       visibility.ts), the claim lookup keeps it reachable;
//   booking.enabled     adapter ↔ experience_providers.booking_live (existing
//                       audit log + admin brake);
//   booking.pause       read by the booking gate (owner-features/gardssalg.ts
//                       gardssalgOwnerBookingPaused, featureOn): a new request
//                       via web, REST and book_gardssalg is refused, the AI
//                       discover note says «tar ikke imot forespørsler nå»,
//                       the profile stays visible;
//   booking.reminder, booking.attendance, notify.booking_email — locked on
//                       while booking.enabled is on (the reminder after N h,
//                       the attendance link and the request e-mail all exist
//                       in booking-store.ts);
//   content.guarantee, comms.unsubscribe — promises (G1 pkt 1 and 6).
// Every other entry is `coming_soon` (the «Planlagt» box, no value) until a
// slice enforces it: visibility.ai_assistants / search_engines / english /
// exact_location and contact.* need per-surface readers; booking.ai_booking
// and booking.within_hours need the booking channels to read them;
// visit.tasting has no public reader (tasting_available is not shown
// anywhere) and no bevilling check; stats.public_counts waits for the public
// threshold on the gårdssalg profile; comms.news/beta/featured have no
// first-login card and nothing that reads the consent; notify.changes /
// report / milestones until the e-mails exist.
// ═══════════════════════════════════════════════════════════════════════════

const GS_DR = "2026-10-22-opplevagent-mine-valg-gardssalg";
const GS_SINCE = "2026-10-29";
const GARDSSALG: OwnerFeatureVertical[] = ["gardssalg"];

export const GARDSSALG_OWNER_FEATURE_GROUPS: Array<{ key: OwnerFeatureGroup; label: LocalizedText }> = [
  { key: "visibility", label: { no: "Hvem kan finne deg", en: "Who can find you" } },
  { key: "contact", label: { no: "Kontaktinformasjon", en: "Contact information" } },
  { key: "booking", label: { no: "Besøk og booking", en: "Visits and booking" } },
  { key: "content", label: { no: "Innhold og oppdatering", en: "Content and updates" } },
  { key: "notify", label: { no: "Varsler til deg", en: "Notifications to you" } },
  { key: "stats", label: { no: "Statistikk og offentlige tall", en: "Statistics and public numbers" } },
  { key: "comms", label: { no: "Kontakt fra Opplevagent", en: "Contact from Opplevagent" } },
];

/** A gårdssalg entry: same defaults as `entry`, gårdssalg vertical and dev-request. */
function gsEntry(
  e: Parameters<typeof entry>[0],
): OwnerFeatureEntry {
  return entry({ verticals: GARDSSALG, since: GS_SINCE, devRequest: GS_DR, ...e });
}

/** Public gårdssalg read surfaces of a profile field (G1 pkt 5 flates). */
const GS_PROFILE_FIELD_SURFACES: OwnerFeatureSurface[] = ["profile_html", "json_ld", "mcp_search", "mcp_info", "rest_card", "a2a"];

export const GARDSSALG_OWNER_FEATURE_REGISTRY: OwnerFeatureEntry[] = [
  // ── Hvem kan finne deg ──────────────────────────────────────────────────
  gsEntry({
    key: "visibility.profile", group: "visibility", type: "switch",
    label: t("Profilen er synlig", "Profile is visible"),
    description: t(
      "Når denne er av, er profilen på pause: borte fra søk, lister, kart og AI-assistenter. Du kan slå den på igjen når som helst.",
      "When off, the profile is paused: removed from search, lists, maps and AI assistants. You can switch it back on at any time.",
    ),
    default: { owner: true, unclaimed: true },
    requires: ["visibilityOwnerControlled"],
    confirmOff: t(
      "Profilen blir borte fra søk, kart og AI-assistenter til du slår den på igjen.",
      "Your profile disappears from search, maps and AI assistants until you switch it back on.",
    ),
    surfaces: ["profile_html", "listing_html", "mcp_search", "mcp_info", "rest_card", "sitemap", "a2a"],
    storage: GARDSSALG_PROFILE_VISIBLE_ADAPTER,
    status: "live",
  }),
  gsEntry({
    key: "visibility.ai_assistants", group: "visibility", type: "switch",
    label: t("Synlig for AI-assistenter", "Visible to AI assistants"),
    description: t("AI-assistenter som ChatGPT og Claude kan finne og anbefale stedet ditt.", "AI assistants such as ChatGPT and Claude can find and recommend your place."),
    default: { owner: true, unclaimed: true },
    requires: ["visibility.profile"],
    confirmOff: t("AI-assistenter vil ikke lenger kunne anbefale deg.", "AI assistants will no longer be able to recommend you."),
    surfaces: ["mcp_search", "mcp_info", "a2a"],
  }),
  gsEntry({
    key: "visibility.search_engines", group: "visibility", type: "switch",
    label: t("Synlig i Google og Bing", "Visible in Google and Bing"),
    description: t("Søkemotorer kan vise profilsiden din i søkeresultater.", "Search engines can show your profile page in search results."),
    default: { owner: true, unclaimed: true },
    requires: ["visibility.profile"],
    surfaces: ["profile_html", "sitemap"],
  }),
  gsEntry({
    key: "visibility.english", group: "visibility", type: "switch",
    label: t("Profil på engelsk", "Profile in English"),
    description: t("Profilen vises også på engelsk (maskinoversatt). Du kan rette teksten selv.", "Your profile is also shown in English (machine-translated). You can correct the text yourself."),
    default: { owner: true, unclaimed: true },
    requires: ["visibility.profile"],
    surfaces: ["profile_html", "sitemap"],
  }),
  gsEntry({
    key: "visibility.exact_location", group: "visibility", type: "switch",
    label: t("Vis eksakt kartpunkt", "Show the exact map point"),
    description: t("Kartet viser nøyaktig hvor du er. Når den er av, vises bare kommunen.", "The map shows exactly where you are. When off, only the municipality is shown."),
    default: { owner: true, unclaimed: true },
    advanced: true,
    surfaces: ["profile_html", "listing_html", "mcp_search"],
  }),

  // ── Kontaktinformasjon ──────────────────────────────────────────────────
  gsEntry({
    key: "contact.phone", group: "contact", type: "switch",
    label: t("Vis telefonnummer", "Show phone number"),
    description: t("Telefonnummeret ditt vises på profilen og for AI-assistenter.", "Your phone number is shown on your profile and to AI assistants."),
    default: { owner: true, unclaimed: true },
    surfaces: GS_PROFILE_FIELD_SURFACES,
  }),
  gsEntry({
    key: "contact.email_mode", group: "contact", type: "choice",
    label: t("E-postadressen din", "Your e-mail address"),
    description: t("Hvordan e-postadressen din vises for besøkende og AI-assistenter.", "How your e-mail address is shown to visitors and AI assistants."),
    options: [
      { value: "show", label: t("Vis e-post", "Show e-mail") },
      { value: "protected", label: t("Skjermet mot innhøsting", "Protected against harvesting") },
      { value: "hidden", label: t("Ikke vis e-post", "Do not show e-mail") },
    ],
    default: { owner: "show", unclaimed: "show" },
    devRequest: "2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting",
    surfaces: GS_PROFILE_FIELD_SURFACES,
  }),
  gsEntry({
    key: "contact.address", group: "contact", type: "choice",
    label: t("Adresse", "Address"),
    description: t("Hvor mye av adressen din som vises.", "How much of your address is shown."),
    options: [
      { value: "full", label: t("Full adresse og kartnål", "Full address and map pin") },
      { value: "place", label: t("Bare sted", "Place only") },
    ],
    default: { owner: "full", unclaimed: "full" },
    surfaces: GS_PROFILE_FIELD_SURFACES,
  }),
  gsEntry({
    key: "contact.booking_email", group: "contact", type: "email",
    label: t("Besøksforespørsler sendes til", "Visit requests are sent to"),
    description: t(
      "E-postadressen besøksforespørslene går til. En ny adresse gjelder når du har bekreftet den.",
      "The e-mail address visit requests go to. A new address applies once you have confirmed it.",
    ),
    nullable: true,
    default: { owner: null, unclaimed: null },
    outward: true,
    surfaces: ["email:booking_request"],
  }),

  // ── Besøk og booking ────────────────────────────────────────────────────
  gsEntry({
    key: "booking.enabled", group: "booking", type: "switch",
    label: t("Ta imot besøk", "Accept visits"),
    description: t(
      "Gjester og AI-assistenter kan be om å komme på besøk. Uten denne får gjesten kontaktinformasjonen din i stedet.",
      "Guests and AI assistants can ask to visit you. Without it, the guest gets your contact details instead.",
    ),
    default: { owner: false, unclaimed: false },
    requires: ["verifiedOwner"],
    enableRequires: ["noBookingAdminBrake", "bookingRequestEmail"],
    confirmOn: t(
      "Du får besøksforespørsler på e-post og må svare gjesten. Du kan slå det av når som helst.",
      "You will receive visit requests by e-mail and must answer the guest. You can switch it off at any time.",
    ),
    status: "live",
    devRequest: "2026-08-08-booking-aktivering-per-produsent",
    surfaces: ["booking_gate", "profile_html", "mcp_search", "a2a", "rest_card", "email:booking_request"],
    storage: GARDSSALG_BOOKING_ENABLED_ADAPTER,
  }),
  gsEntry({
    key: "booking.pause", group: "booking", type: "switch",
    label: t("Sesongpause: ta ikke imot nye forespørsler", "Seasonal pause: do not accept new requests"),
    description: t(
      "Nye besøksforespørsler stoppes, og gjester og AI-assistenter får beskjed om at du ikke tar imot forespørsler nå. Profilen er fortsatt synlig.",
      "New visit requests are stopped, and guests and AI assistants are told you are not taking requests right now. Your profile stays visible.",
    ),
    default: { owner: false, unclaimed: null },
    requires: ["booking.enabled"],
    confirmOn: t(
      "Nye forespørsler stoppes til du slår pausen av. Forespørsler du allerede har fått, må du fortsatt svare på.",
      "New requests are stopped until you switch the pause off. Requests you already have must still be answered.",
    ),
    status: "live",
    surfaces: ["booking_gate", "mcp_search", "a2a", "rest_card"],
  }),
  gsEntry({
    key: "booking.ai_booking", group: "booking", type: "switch",
    label: t("AI-assistenter kan sende forespørsler", "AI assistants can send requests"),
    description: t("En AI-assistent kan sende en besøksforespørsel for en gjest.", "An AI assistant can send a visit request on behalf of a guest."),
    default: { owner: true, unclaimed: null },
    requires: ["booking.enabled"],
    surfaces: ["booking_gate", "mcp_search"],
  }),
  gsEntry({
    key: "booking.within_hours", group: "booking", type: "switch",
    label: t("Bare forespørsler innenfor åpningstidene", "Only requests within opening hours"),
    description: t("Forespørsler utenfor åpningstidene dine blir ikke tatt imot.", "Requests outside your opening hours are not accepted."),
    default: { owner: false, unclaimed: null },
    requires: ["booking.enabled"],
    surfaces: ["booking_gate"],
  }),
  gsEntry({
    key: "booking.reminder", group: "booking", type: "locked",
    label: t("Påminnelse om ubesvarte forespørsler", "Reminder about unanswered requests"),
    description: t("Du får en påminnelse når en forespørsel ikke er besvart.", "You get a reminder when a request has not been answered."),
    default: { owner: false, unclaimed: null },
    lockedWhen: "booking.enabled",
    status: "live",
    outward: true,
    devRequest: "2026-07-14-booking-flyt-v1",
    surfaces: ["email:booking_reminder", "job:booking_previsit"],
  }),
  gsEntry({
    key: "booking.attendance", group: "booking", type: "locked",
    label: t("Bekreft oppmøte etter besøket", "Confirm attendance after the visit"),
    description: t("Etter besøket bekrefter du med lenken i e-posten om gjesten kom.", "After the visit you confirm with the link in the e-mail whether the guest came."),
    default: { owner: false, unclaimed: null },
    lockedWhen: "booking.enabled",
    status: "live",
    devRequest: "2026-07-14-booking-flyt-v1",
    surfaces: ["email:booking_request"],
  }),
  gsEntry({
    key: "visit.tasting", group: "booking", type: "choice",
    label: t("Smaking ved besøk", "Tasting during the visit"),
    description: t(
      "Om gjestene kan smake ved besøket. Smaking krever gyldig bevilling. Opplevagent selger ikke drikke, og reglene for salg på gården er foreløpig bare et forslag.",
      "Whether guests can taste during the visit. Tasting requires a valid licence. Opplevagent does not sell drinks, and the rules for selling at the farm are only a proposal so far.",
    ),
    options: [
      { value: "none", label: t("Ingen smaking", "No tasting") },
      { value: "licensed", label: t("Smaking (med bevilling)", "Tasting (with licence)") },
    ],
    default: { owner: "none", unclaimed: "none" },
    surfaces: ["profile_html", "mcp_info"],
  }),
  gsEntry({
    key: "booking.expiry", group: "booking", type: "choice",
    label: t("Svarfrist før forespørselen utløper", "Answer deadline before the request expires"),
    description: t("Hvor lenge en forespørsel venter på svar før den utløper.", "How long a request waits for an answer before it expires."),
    options: [
      { value: "48", label: t("48 timer", "48 hours") },
      { value: "60", label: t("60 timer", "60 hours") },
      { value: "72", label: t("72 timer", "72 hours") },
    ],
    default: { owner: "60", unclaimed: null },
    requires: ["booking.enabled"],
    advanced: true,
    surfaces: ["booking_gate", "job:booking_previsit"],
  }),
  gsEntry({
    key: "booking.lead_time", group: "booking", type: "choice",
    label: t("Varsel før besøk", "Notice before a visit"),
    description: t("Hvor tidlig gjesten må be om besøket.", "How early the guest must ask for the visit."),
    options: [
      { value: "same_day", label: t("Samme dag", "Same day") },
      { value: "one_day", label: t("Dagen før", "The day before") },
      { value: "two_days", label: t("To dager før", "Two days before") },
    ],
    default: { owner: "same_day", unclaimed: null },
    requires: ["booking.enabled"],
    advanced: true,
    surfaces: ["booking_gate"],
  }),
  gsEntry({
    key: "booking.party_size", group: "booking", type: "number",
    label: t("Største gruppe", "Largest group"),
    description: t("Det største antallet personer en forespørsel kan gjelde.", "The largest number of people a request can be for."),
    min: 1, max: 50,
    default: { owner: 50, unclaimed: null },
    requires: ["booking.enabled"],
    advanced: true,
    surfaces: ["booking_gate"],
  }),

  // ── Innhold og oppdatering ──────────────────────────────────────────────
  gsEntry({
    key: "content.guarantee", group: "content", type: "guarantee",
    label: t("Det du skriver selv, overskrives aldri", "What you write yourself is never overwritten"),
    description: t(
      "Opplevagent skriver aldri over tekst du har skrevet selv. Du kan gi et felt tilbake i eierportalen.",
      "Opplevagent never overwrites text you have written yourself. You can give a field back in the owner portal.",
    ),
    default: { owner: true, unclaimed: null },
    status: "live",
    surfaces: ["job:gardssalg_content_refresh", "job:rfb_knowledge_enrich"],
  }),
  gsEntry({
    key: "content.auto_updates", group: "content", type: "choice",
    label: t("Oppdatering fra nettsiden din", "Updates from your website"),
    description: t("Hva som skjer når vi finner ny informasjon om deg på nettsiden din.", "What happens when we find new information about you on your website."),
    options: [
      { value: "suggest", label: t("Foreslå til meg", "Suggest to me") },
      { value: "never", label: t("Aldri", "Never") },
    ],
    default: { owner: "suggest", unclaimed: null },
    surfaces: ["job:gardssalg_content_refresh"],
  }),
  gsEntry({
    key: "content.photos", group: "content", type: "switch",
    label: t("Hent bilder fra nettsiden min", "Fetch photos from my website"),
    description: t("Bilder fra nettsiden din kan brukes på profilen.", "Photos from your website can be used on your profile."),
    default: { owner: false, unclaimed: false },
    consent: true,
    devRequest: "2026-07-03-gardssalg-rike-profiler-bilder-agentbooking",
    surfaces: ["job:photo_import", "profile_html"],
  }),

  // ── Varsler til deg ─────────────────────────────────────────────────────
  gsEntry({
    key: "notify.booking_email", group: "notify", type: "locked",
    label: t("Forespørsler på e-post", "Requests by e-mail"),
    description: t("Hver ny besøksforespørsel sendes til deg på e-post.", "Every new visit request is sent to you by e-mail."),
    default: { owner: false, unclaimed: null },
    lockedWhen: "booking.enabled",
    status: "live",
    outward: true,
    surfaces: ["email:booking_request"],
  }),
  gsEntry({
    key: "notify.booking_sms", group: "notify", type: "switch",
    label: t("SMS ved ny forespørsel", "Text message on a new request"),
    description: t("Du får en SMS når en ny besøksforespørsel kommer.", "You get a text message when a new visit request arrives."),
    default: { owner: false, unclaimed: null },
    requires: ["booking.enabled"],
    outward: true,
    surfaces: ["job:booking_sms"],
  }),
  gsEntry({
    key: "notify.report", group: "notify", type: "choice",
    label: t("Rapport om profilen din", "Report about your profile"),
    description: t("Visninger og «Med i AI-søk», sendt på e-post.", "Views and “In AI search”, sent by e-mail."),
    options: [
      { value: "monthly", label: t("Månedlig", "Monthly") },
      { value: "quarterly", label: t("Hvert kvartal", "Quarterly") },
      { value: "off", label: t("Aldri", "Never") },
    ],
    default: { owner: "monthly", unclaimed: "monthly" },
    outward: true,
    surfaces: ["email:owner_monthly_report"],
  }),
  gsEntry({
    key: "notify.milestones", group: "notify", type: "switch",
    label: t("Milepæler", "Milestones"),
    description: t("En e-post når profilen når 100, 500 og 1000 visninger.", "An e-mail when your profile reaches 100, 500 and 1000 views."),
    default: { owner: true, unclaimed: true },
    outward: true,
    surfaces: ["email:owner_milestone"],
  }),
  gsEntry({
    key: "notify.changes", group: "notify", type: "switch",
    label: t("Si fra når noe endres på profilen min", "Tell me when something changes on my profile"),
    description: t("En samlet e-post per dag når noe på profilen er endret av andre enn deg.", "One daily e-mail when something on your profile was changed by someone other than you."),
    default: { owner: true, unclaimed: true },
    outward: true,
    surfaces: ["email:owner_changes"],
  }),

  // ── Statistikk og offentlige tall ───────────────────────────────────────
  gsEntry({
    key: "stats.public_counts", group: "stats", type: "switch",
    label: t("Vis «Med i AI-søk» på profilen", "Show “In AI search” on the profile"),
    description: t(
      "Profilen viser hvor ofte den var med i AI-søk. Du ser alltid dine egne tall.",
      "Your profile shows how often it was in AI search. You always see your own numbers.",
    ),
    default: { owner: true, unclaimed: true },
    surfaces: ["profile_html"],
  }),
  gsEntry({
    key: "stats.share_partner", group: "stats", type: "switch",
    label: t("Del statistikken min med samarbeidspartnere", "Share my statistics with partners"),
    description: t("Partnere du er tilknyttet kan se statistikken din i sine rapporter.", "Partners you are affiliated with can see your statistics in their reports."),
    default: { owner: false, unclaimed: false },
    consent: true,
    outward: true,
    surfaces: ["email:partner_report"],
  }),

  // ── Kontakt fra Opplevagent ─────────────────────────────────────────────
  gsEntry({
    key: "comms.unsubscribe", group: "comms", type: "guarantee",
    label: t("Avmelding uten å slette profilen", "Unsubscribe without deleting the profile"),
    description: t(
      "Du kan alltid melde deg av e-post fra Opplevagent uten at profilen slettes.",
      "You can always unsubscribe from Opplevagent e-mails without your profile being deleted.",
    ),
    default: { owner: true, unclaimed: true },
    status: "live",
    surfaces: ["email:outreach"],
  }),
  gsEntry({
    key: "comms.news", group: "comms", type: "switch",
    label: t("Nyheter og tips", "News and tips"),
    description: t("Om du vil ha nyheter og tips fra Opplevagent på e-post.", "Whether you want news and tips from Opplevagent by e-mail."),
    default: { owner: false, unclaimed: false },
    consent: true,
    outward: true,
    surfaces: [],
  }),
  gsEntry({
    key: "comms.beta", group: "comms", type: "switch",
    label: t("Prøv nye funksjoner først", "Try new features first"),
    description: t("Du får tilbud om å prøve nye funksjoner før andre.", "You are offered new features before others."),
    default: { owner: false, unclaimed: false },
    outward: true,
    surfaces: ["email:beta_invite"],
  }),
  gsEntry({
    key: "comms.featured", group: "comms", type: "switch",
    label: t("Opplevagent kan vise fram stedet mitt", "Opplevagent may feature my place"),
    description: t("Vi kan omtale stedet ditt i sosiale medier og nyhetsbrev.", "We may feature your place on social media and in newsletters."),
    default: { owner: false, unclaimed: false },
    consent: true,
    outward: true,
    surfaces: ["job:social_media"],
  }),
  gsEntry({
    key: "tools.badge", group: "comms", type: "action",
    label: t("Hent «Finn oss på Opplevagent»-merke", "Get a “Find us on Opplevagent” badge"),
    description: t("Et merke du kan legge på nettsiden din, med lenke til profilen.", "A badge you can put on your website, linking to your profile."),
    default: { owner: null, unclaimed: null },
    devRequest: "2026-07-12-opplevagent-lenkeplan",
    surfaces: ["profile_html"],
  }),
];

/** The registry for a vertical (the resolver, page and API default to it). */
export function ownerFeatureRegistryFor(vertical: OwnerFeatureVertical): OwnerFeatureEntry[] {
  return vertical === "gardssalg" ? GARDSSALG_OWNER_FEATURE_REGISTRY : OWNER_FEATURE_REGISTRY;
}

/** The groups (order and labels) for a vertical. */
export function ownerFeatureGroupsFor(vertical: OwnerFeatureVertical): Array<{ key: OwnerFeatureGroup; label: LocalizedText }> {
  return vertical === "gardssalg" ? GARDSSALG_OWNER_FEATURE_GROUPS : OWNER_FEATURE_GROUPS;
}

/** The registry keys for a vertical (governance: registry keys == this list). */
export function ownerFeatureKeysFor(vertical: OwnerFeatureVertical): readonly string[] {
  return vertical === "gardssalg" ? GARDSSALG_OWNER_FEATURE_KEYS : OWNER_FEATURE_KEYS;
}

/** Thrown for a key that is not in the registry — never a silent false. */
export class UnknownOwnerFeatureError extends Error {
  constructor(public readonly key: string) {
    super(`unknown owner feature key: ${key}`);
    this.name = "UnknownOwnerFeatureError";
  }
}

export function isOwnerFeatureKey(key: unknown): key is OwnerFeatureKey {
  return typeof key === "string" && (OWNER_FEATURE_KEYS as readonly string[]).includes(key);
}

export function findOwnerFeature(key: string, registry: OwnerFeatureEntry[] = OWNER_FEATURE_REGISTRY): OwnerFeatureEntry | undefined {
  return registry.find((e) => e.key === key);
}

export function getOwnerFeature(key: string, registry: OwnerFeatureEntry[] = OWNER_FEATURE_REGISTRY): OwnerFeatureEntry {
  const e = findOwnerFeature(key, registry);
  if (!e) throw new UnknownOwnerFeatureError(key);
  return e;
}
