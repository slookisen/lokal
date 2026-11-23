/**
 * gardssalg-cards.ts — O5-6 «kort i samtalen» (dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter), behind
 * GARDSSALG_MCP_CARDS_ENABLED (off unless exactly "true").
 *
 * Two MCP Apps cards (`text/html;profile=mcp-app`, served by
 * experiences-mcp.ts as `ui://` resources only while the flag is on):
 *   (a) the producer list for discover_gardssalg: name, type of place,
 *       municipality, whether it takes visit requests, and at most two
 *       actions: «Be om besøk» (a follow-up message in the conversation) and
 *       «Profilside» (a link);
 *   (b) the booking summary for book_gardssalg and get_gardssalg_booking:
 *       producer, time in words, party size, status badge and «Se status»
 *       (a link). With `preview: true` it shows what is sent, and to whom.
 *
 * Rules the cards keep (Daniel 12.11, the content rules of the dev-request):
 *   - the card never writes: its actions are a message in the conversation
 *     (so the host still shows its own confirmation before book_gardssalg
 *     sends anything) or a link on the platform's own domain;
 *   - no images of any kind, no product names, no prices, no share function,
 *     never the word «tasting»; the card data holds only the fields below;
 *   - nothing is loaded from the network (inline CSS/JS, empty CSP lists);
 *   - no `ui.domain`: Claude rejects any value but its own
 *     `<hash>.claudemcpcontent.com` and shows an error instead of the card.
 *     ChatGPT's dedicated origin is given with its own alias
 *     `openai/widgetDomain` (see experiences-mcp.ts registerCardResource).
 *
 * Texts verbatim from text package OA-2 §D (A2A marketing-drafts/
 * 2026-11-12-opplevagent-tekstpakke-oa-2.md, approved by Daniel 2026-11-15).
 * Do not reword here. The language follows the conversation (host locale).
 */

import { z } from "zod";

export function gardssalgCardsEnabled(): boolean {
  return process.env.GARDSSALG_MCP_CARDS_ENABLED === "true";
}

// New URIs (date-suffixed like the experience cards): a changed template gets
// a new URI so hosts do not serve a cached old one.
export const GARDSSALG_LIST_CARD_URI = "ui://opplevagent/gardssalg-producers-2026-11-23";
export const GARDSSALG_BOOKING_CARD_URI = "ui://opplevagent/gardssalg-booking-2026-11-23";

/** At most this many producers on the list card; the full list is in the text. */
export const GARDSSALG_LIST_CARD_MAX = 8;

export const CARD_TEXTS = {
  "card.list.title": { nb: "Produsenter du kan besøke", en: "Producers you can visit" },
  "card.list.acceptsRequests": { nb: "Tar imot forespørsler", en: "Accepts visit requests" },
  "card.list.noRequests": { nb: "Kontakt produsenten direkte", en: "Contact the producer directly" },
  "card.list.requestAction": { nb: "Be om besøk", en: "Request a visit" },
  "card.list.profileAction": { nb: "Profilside", en: "Profile page" },
  "card.list.empty": { nb: "Ingen produsenter passet søket.", en: "No producers matched the search." },
  "card.list.requestPrompt": { nb: "Jeg vil be om besøk hos {produsent}.", en: "I would like to request a visit to {produsent}." },
  "card.booking.title": { nb: "Besøk hos {produsent}", en: "Visit to {produsent}" },
  "card.booking.titlePending": { nb: "Forespørsel om besøk hos {produsent}", en: "Visit request to {produsent}" },
  "card.booking.time": { nb: "Tidspunkt", en: "Time" },
  "card.booking.party": { nb: "Antall", en: "Guests" },
  "card.booking.ref": { nb: "Referanse", en: "Reference" },
  "card.booking.statusAction": { nb: "Se status", en: "See status" },
  "card.badge.pending": { nb: "Venter på svar", en: "Waiting for a reply" },
  "card.badge.confirmed": { nb: "Bekreftet", en: "Confirmed" },
  "card.badge.suggested": { nb: "Nytt tidspunkt foreslått", en: "New time suggested" },
  "card.badge.declined": { nb: "Avslått", en: "Declined" },
  "card.badge.expired": { nb: "Utløpt", en: "Expired" },
  "card.badge.cancelled": { nb: "Avlyst", en: "Cancelled" },
  "card.badge.withdrawn": { nb: "Trukket", en: "Withdrawn" },
  "card.preview.title": { nb: "Dette sendes hvis du sier ja", en: "This is sent if you say yes" },
  "card.preview.to": { nb: "Sendes til {produsent}", en: "Sent to {produsent}" },
  "card.preview.notSent": { nb: "Ingenting er sendt ennå.", en: "Nothing has been sent yet." },
} as const;

// ─── Card data (the `card` key of structuredContent) ───────────────────────
// structuredContent is the tool's whole text payload plus `card`, so a host
// that reads only structuredContent (Claude Code does) still gets the full
// answer, and the card reads only `card`.

const Bilingual = z.object({ nb: z.string(), en: z.string() }).strict();
const OwnUrl = (origin: string) => z.string().refine((u) => u.startsWith(origin + "/"), "link on the platform's own domain");

export const CARD_BADGES = ["pending", "confirmed", "suggested", "declined", "expired", "cancelled", "withdrawn"] as const;
export type CardBadge = (typeof CARD_BADGES)[number];

export const GARDSSALG_CARD_ORIGIN = "https://opplevagent.no";

export const GardssalgListCardSchema = z.object({
  kind: z.literal("gardssalg_producers"),
  producers: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    place_type: z.string().nullable(),
    kommune: z.string().nullable(),
    accepts_requests: z.boolean(),
    profile_url: OwnUrl(GARDSSALG_CARD_ORIGIN).nullable(),
  }).strict()).max(GARDSSALG_LIST_CARD_MAX),
}).strict();
export type GardssalgListCard = z.infer<typeof GardssalgListCardSchema>;

export const GardssalgBookingCardSchema = z.object({
  kind: z.literal("gardssalg_booking"),
  preview: z.boolean(),
  producer: z.string().min(1),
  status: z.enum(CARD_BADGES).nullable(),
  time: Bilingual,
  party_size: z.number().int().positive(),
  booking_ref: z.string().min(1).nullable(),
  status_url: OwnUrl(GARDSSALG_CARD_ORIGIN).nullable(),
  preview_lines: z.array(Bilingual),
}).strict().refine(
  (c) => (c.preview
    ? c.status === null && c.booking_ref === null && c.status_url === null
    : c.status !== null && c.booking_ref !== null && c.preview_lines.length === 0),
  "a preview has no status, reference or status link; a request has a status and a reference",
);
export type GardssalgBookingCard = z.infer<typeof GardssalgBookingCardSchema>;

export const GardssalgListStructuredSchema = z.looseObject({ card: GardssalgListCardSchema });
export const GardssalgBookingStructuredSchema = z.looseObject({ card: GardssalgBookingCardSchema });

const ownUrlOrNull = (u: unknown): string | null =>
  typeof u === "string" && u.startsWith(GARDSSALG_CARD_ORIGIN + "/") ? u : null;

/** The list card from discover_gardssalg's rows (only the fields the card shows). */
export function buildGardssalgListCard(rows: Array<{
  id: string; navn: string; producer_type?: string | null; kommune?: string | null;
  booking: { mode: string }; profile_url: string | null;
}>): GardssalgListCard {
  return {
    kind: "gardssalg_producers",
    producers: rows.slice(0, GARDSSALG_LIST_CARD_MAX).map((r) => ({
      id: r.id,
      name: r.navn,
      place_type: r.producer_type ?? null,
      kommune: r.kommune ?? null,
      accepts_requests: r.booking.mode === "request",
      profile_url: ownUrlOrNull(r.profile_url),
    })),
  };
}

/** get_gardssalg_booking's status keys (GARDSSALG_STATUS_TEXT) as a card badge. */
export function cardBadgeForStatusKey(key: string): CardBadge | null {
  switch (key) {
    case "pending": case "confirmed": case "suggested": case "declined": case "expired": return key;
    case "cancelledByGuest": case "cancelledByProducer": return "cancelled";
    case "withdrawnByGuest": return "withdrawn";
    default: return null;
  }
}

/** "norsk / English" lines (the tool's result texts) as {nb, en}. */
export function splitBilingualLine(line: string): { nb: string; en: string } {
  const i = line.indexOf(" / ");
  return i < 0 ? { nb: line, en: line } : { nb: line.slice(0, i), en: line.slice(i + 3) };
}

export function buildGardssalgBookingCard(v: {
  preview: boolean;
  producer: string;
  status: CardBadge | null;
  time: { nb: string; en: string };
  partySize: number;
  bookingRef: string | null;
  statusUrl: unknown;
  previewLines?: string[];
}): GardssalgBookingCard {
  return {
    kind: "gardssalg_booking",
    preview: v.preview,
    producer: v.producer,
    status: v.preview ? null : v.status,
    time: v.time,
    party_size: v.partySize,
    booking_ref: v.preview ? null : v.bookingRef,
    status_url: v.preview ? null : ownUrlOrNull(v.statusUrl),
    preview_lines: v.preview ? (v.previewLines ?? []).map(splitBilingualLine) : [],
  };
}

// ─── HTML ──────────────────────────────────────────────────────────────────
// Plain ES5-style scripts (no template literals inside), every data value
// HTML-escaped. The bridge is the MCP Apps one (ui/initialize, then
// ui/notifications/tool-result with the CallToolResult) with ChatGPT's
// window.openai alias as a fallback, like opplevagent-widgets.ts. No images,
// no network: the CSS has no url() and the script loads nothing.

const CARD_STYLE = `
  :root { --bg:#ffffff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --chip:#f3f4f6; --accent:#047857; --accent-fg:#ffffff; }
  :root.dark { --bg:#212121; --fg:#f3f4f6; --muted:#a1a1aa; --line:#3f3f46; --chip:#2f2f2f; --accent:#34d399; --accent-fg:#052e16; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 8px; }
  .muted { color: var(--muted); font-size: 13px; margin: 4px 0 8px; }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin-bottom: 8px; }
  h2 { margin: 0 0 8px; font-size: 17px; }
  h3 { margin: 0 0 6px; font-size: 15px; }
  p { margin: 0 0 8px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 8px; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
  .chip { background: var(--chip); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
  .badge { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600;
           background: var(--chip); margin: 0 0 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button { font: inherit; font-size: 13px; min-height: 44px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
           border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
`;

const CARD_HELPERS = `
  var TX = ${JSON.stringify(CARD_TEXTS)};
  var OWN = ${JSON.stringify(GARDSSALG_CARD_ORIGIN + "/")};
  var root = document.getElementById("root");
  var state = { data: null, theme: null, locale: null, initialized: false };
  var inHost = !!(window.parent && window.parent !== window);
  var nextId = 1;
  var pending = {};
  function oa() { return window.openai || {}; }
  function post(msg) {
    if (!inHost) return;
    try { window.parent.postMessage(msg, "*"); } catch (err) { /* host gone */ }
  }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  window.addEventListener("message", function (ev) {
    if (!inHost || ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") {
      var sc = m.params && m.params.structuredContent;
      if (sc && typeof sc === "object") { state.data = sc; render(); }
    } else if (m.method === "ui/notifications/host-context-changed") {
      if (m.params && m.params.theme) state.theme = m.params.theme;
      if (m.params && m.params.locale) state.locale = m.params.locale;
      render();
    }
  }, { passive: true });
  function currentCard(kind) {
    var d = state.data;
    if (!d) { var out = oa().toolOutput; d = out && typeof out === "object" ? out : null; }
    var c = d && d.card;
    return c && typeof c === "object" && c.kind === kind ? c : null;
  }
  function isNo() {
    return /^(nb|nn|no)\\b/i.test(String(state.locale || oa().locale || (typeof navigator !== "undefined" && navigator.language) || ""));
  }
  function tx(key, produsent) {
    var e = TX[key];
    var s = e ? (isNo() ? e.nb : e.en) : "";
    return produsent === undefined ? s : s.split("{produsent}").join(produsent);
  }
  function bi(v) { return v && typeof v === "object" ? (isNo() ? v.nb : v.en) : ""; }
  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function openLink(href) {
    if (String(href || "").indexOf(OWN) !== 0) return;
    var host = oa();
    if (typeof host.openExternal === "function") { host.openExternal({ href: href, redirectUrl: false }); return; }
    if (!inHost) { window.open(href, "_blank", "noopener"); return; }
    request("ui/open-link", { url: href }).catch(function () { /* host declined */ });
  }
  function ask(prompt) {
    var host = oa();
    if (typeof host.sendFollowUpMessage === "function") { host.sendFollowUpMessage({ prompt: prompt }); return; }
    request("ui/message", { role: "user", content: { type: "text", text: prompt } }).catch(function () { /* host declined */ });
  }
  function fitHeight() {
    var h = Math.ceil(document.body.scrollHeight);
    if (state.initialized) notify("ui/notifications/size-changed", { width: Math.ceil(document.body.scrollWidth), height: h });
    var host = oa();
    if (typeof host.notifyIntrinsicHeight === "function") {
      try { host.notifyIntrinsicHeight(h); } catch (err) { /* optional host API */ }
    }
  }
  function applyTheme() {
    var theme = state.theme || oa().theme;
    if (!theme && window.matchMedia) theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
  root.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-href],[data-ask]") : null;
    if (!el) return;
    if (el.getAttribute("data-href")) openLink(el.getAttribute("data-href"));
    else if (el.getAttribute("data-ask")) ask(el.getAttribute("data-ask"));
  });
  window.addEventListener("openai:set_globals", function () { render(); }, { passive: true });
  function start() {
    render();
    if (!inHost) return;
    request("ui/initialize", {
      appInfo: { name: "Opplevagent", version: "1.1.0" },
      appCapabilities: { availableDisplayModes: ["inline"] },
      protocolVersion: "2026-01-26"
    }).then(function (result) {
      var ctx = result && result.hostContext;
      if (ctx && ctx.theme) state.theme = ctx.theme;
      if (ctx && ctx.locale) state.locale = ctx.locale;
      notify("ui/notifications/initialized", {});
      state.initialized = true;
      render();
    }).catch(function () { /* host without the MCP Apps handshake: window.openai path still works */ });
  }
`;

function cardDocument(script: string): string {
  return `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opplevagent</title>
<style>${CARD_STYLE}</style>
</head>
<body>
<div id="root" aria-live="polite"></div>
<script>
(function () {
${CARD_HELPERS}
${script}
  start();
})();
</script>
</body>
</html>`;
}

export const GARDSSALG_LIST_CARD_HTML = cardDocument(`
  function row(p) {
    var name = String(p.name || "");
    var acts = "";
    if (p.accepts_requests) {
      acts += '<button type="button" class="primary" data-ask="' + esc(tx("card.list.requestPrompt", name)) + '">' + esc(tx("card.list.requestAction")) + "</button>";
    }
    if (p.profile_url) acts += '<button type="button" data-href="' + esc(p.profile_url) + '">' + esc(tx("card.list.profileAction")) + " \\u2197</button>";
    var chips = [];
    if (p.place_type) chips.push('<span class="chip">' + esc(p.place_type) + "</span>");
    if (p.kommune) chips.push('<span class="chip">' + esc(p.kommune) + "</span>");
    chips.push('<span class="chip">' + esc(tx(p.accepts_requests ? "card.list.acceptsRequests" : "card.list.noRequests")) + "</span>");
    return '<div class="card"><h3>' + esc(name) + "</h3>" +
      '<div class="chips">' + chips.join("") + "</div>" +
      (acts ? '<div class="actions">' + acts + "</div>" : "") + "</div>";
  }
  function render() {
    applyTheme();
    var c = currentCard("gardssalg_producers");
    if (!c) { root.innerHTML = ""; fitHeight(); return; }
    var list = Array.isArray(c.producers) ? c.producers : [];
    var html = "<h2>" + esc(tx("card.list.title")) + "</h2>";
    if (!list.length) html += '<p class="muted">' + esc(tx("card.list.empty")) + "</p>";
    for (var i = 0; i < list.length; i++) html += row(list[i]);
    root.innerHTML = html;
    fitHeight();
  }
`);

export const GARDSSALG_BOOKING_CARD_HTML = cardDocument(`
  function render() {
    applyTheme();
    var c = currentCard("gardssalg_booking");
    if (!c) { root.innerHTML = ""; fitHeight(); return; }
    var producer = String(c.producer || "");
    var html = '<div class="card">';
    if (c.preview) {
      html += "<h2>" + esc(tx("card.preview.title")) + "</h2>" +
        "<p>" + esc(tx("card.preview.to", producer)) + "</p>";
    } else {
      html += "<h2>" + esc(tx(c.status === "pending" ? "card.booking.titlePending" : "card.booking.title", producer)) + "</h2>" +
        (c.status ? '<span class="badge">' + esc(tx("card.badge." + c.status)) + "</span>" : "");
    }
    html += "<dl>" +
      "<dt>" + esc(tx("card.booking.time")) + "</dt><dd>" + esc(bi(c.time)) + "</dd>" +
      "<dt>" + esc(tx("card.booking.party")) + "</dt><dd>" + esc(c.party_size) + "</dd>" +
      (c.booking_ref ? "<dt>" + esc(tx("card.booking.ref")) + "</dt><dd>" + esc(c.booking_ref) + "</dd>" : "") +
      "</dl>";
    if (c.preview) {
      var lines = Array.isArray(c.preview_lines) ? c.preview_lines : [];
      for (var i = 0; i < lines.length; i++) html += '<p class="muted">' + esc(bi(lines[i])) + "</p>";
      html += "<p>" + esc(tx("card.preview.notSent")) + "</p>";
    } else if (c.status_url) {
      html += '<div class="actions"><button type="button" class="primary" data-href="' + esc(c.status_url) + '">' + esc(tx("card.booking.statusAction")) + " \\u2197</button></div>";
    }
    root.innerHTML = html + "</div>";
    fitHeight();
  }
`);
