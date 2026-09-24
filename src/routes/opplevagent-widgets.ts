/**
 * opplevagent-widgets.ts — the two ChatGPT inline card templates served by
 * experiences-mcp.ts as MCP resources (ui://opplevagent/experiences-list and
 * ui://opplevagent/experience-detail).
 *
 * ChatGPT app review 2026-09-24 (Opplevagent v1.0.0 rejected: "one or more of
 * your test cases did not produce correct results … on both ChatGPT web and
 * mobile"). The previous templates read their data through
 * `window.openai.getToolOutput()` — a function the ChatGPT host has never
 * provided (it only existed in opplevagent-connectors-prep/assets/
 * generate-screenshots.js's own mock) — and the tools returned no
 * `structuredContent` for a widget to read anyway. Inside ChatGPT every list
 * card therefore said "Ingen opplevelser funnet." while the assistant listed
 * experiences in text, and the detail card rendered empty.
 *
 * What the host actually provides (ChatGPT implements the MCP Apps standard,
 * resources served as `text/html;profile=mcp-app`, with `window.openai` as a
 * ChatGPT compatibility layer on top):
 *   - the tool result's `structuredContent`, delivered as a
 *     `ui/notifications/tool-result` message after the `ui/initialize`
 *     handshake, and mirrored in `window.openai.toolOutput` (+ an
 *     `openai:set_globals` event). Either can arrive AFTER the script first
 *     runs (typical on mobile), so render() re-runs on each instead of
 *     reading once.
 *   - `ui/open-link` / window.openai.openExternal({ href }) — the supported
 *     way to open a link; a target="_blank" anchor is not reliable in the
 *     mobile apps.
 *   - `ui/message` / window.openai.sendFollowUpMessage({ prompt }).
 *   - host theme (dark mode) and locale (Norwegian vs English labels).
 *
 * The scripts are plain ES5-style string concatenation (no template literals)
 * so the HTML can live inside a TS template literal without escaping, and
 * every data value is HTML-escaped before it reaches innerHTML.
 */

const WIDGET_STYLE = `
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
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
  .chip { background: var(--chip); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button { font: inherit; font-size: 13px; min-height: 36px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
           border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
`;

// Shared helpers injected into both templates. Data arrives through either
// bridge, whichever the host speaks:
//   - MCP Apps (the current standard ChatGPT implements): the View sends
//     `ui/initialize`, then `ui/notifications/initialized`; the host answers
//     with `ui/notifications/tool-result` carrying the CallToolResult, whose
//     `structuredContent` is what we render.
//   - ChatGPT's compatibility alias: `window.openai.toolOutput`, updated
//     together with an `openai:set_globals` event.
// Links and follow-ups likewise prefer window.openai.openExternal /
// sendFollowUpMessage and fall back to the standard `ui/open-link` /
// `ui/message` requests.
const WIDGET_HELPERS = `
  var root = document.getElementById("root");
  var state = { data: null, theme: null, showAll: false, initialized: false };
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
      if (m.params && m.params.theme) { state.theme = m.params.theme; render(); }
    }
  }, { passive: true });
  function currentData() {
    if (state.data) return state.data;
    var out = oa().toolOutput;
    return out && typeof out === "object" ? out : null;
  }
  function isNo() { return /^(nb|nn|no)\\b/i.test(String(oa().locale || (typeof navigator !== "undefined" && navigator.language) || "")); }
  function t(no, en) { return isNo() ? no : en; }
  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  var CATEGORY_LABELS = {
    kultur_historie: ["Kultur og historie", "Culture & history"],
    natur_friluft: ["Natur og friluft", "Nature & outdoors"],
    adrenalin_action: ["Adrenalin og action", "Adrenaline & action"],
    sightseeing_transport: ["Sightseeing", "Sightseeing"],
    overnatting_opplevelse: ["Overnatting", "Stays"],
    dyreliv_safari: ["Dyreliv og safari", "Wildlife & safari"],
    vinter_sno: ["Vinter og snø", "Winter & snow"],
    mat_drikke: ["Mat og drikke", "Food & drink"],
    velvaere_spa: ["Velvære og spa", "Wellness & spa"]
  };
  function categoryLabel(slug) {
    var l = CATEGORY_LABELS[slug];
    return l ? t(l[0], l[1]) : (slug || "");
  }
  function place(e) {
    var parts = [];
    if (e.kommune) parts.push(e.kommune);
    if (e.fylke && e.fylke !== e.kommune) parts.push(e.fylke);
    return parts.join(", ");
  }
  function price(e) {
    return typeof e.price_from === "number" ? t("fra " + e.price_from + " kr", "from NOK " + e.price_from) : "";
  }
  function duration(e) {
    var m = e.duration_min;
    if (typeof m !== "number" || m <= 0 || m >= 1440) return "";
    return m < 90 ? m + " min" : (Math.round(m / 30) / 2) + t(" t", " h");
  }
  function chips(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) if (values[i]) out.push('<span class="chip">' + esc(values[i]) + "</span>");
    return out.length ? '<div class="chips">' + out.join("") + "</div>" : "";
  }
  function pageUrl(e) {
    return e && e.slug ? "https://opplevagent.no/opplevelse/" + encodeURIComponent(e.slug) : "";
  }
  function openLink(href) {
    if (!/^https?:\\/\\//i.test(href || "")) return;
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
    if (state.initialized && h > 0) notify("ui/notifications/size-changed", { width: Math.ceil(document.body.scrollWidth), height: h });
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
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-href],[data-ask],[data-more]") : null;
    if (!el) return;
    if (el.getAttribute("data-href")) openLink(el.getAttribute("data-href"));
    else if (el.getAttribute("data-ask")) ask(el.getAttribute("data-ask"));
    else if (el.hasAttribute("data-more")) { state.showAll = true; render(); }
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
      notify("ui/notifications/initialized", {});
      state.initialized = true;
      render();
    }).catch(function () { /* host without the MCP Apps handshake: window.openai path still works */ });
  }
`;

// How many list cards to show before the "show all" button. Inline cards in
// ChatGPT should stay compact; the full list is always in the model's text.
const LIST_PREVIEW_COUNT = 5;

export const EXPERIENCES_LIST_HTML = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opplevagent</title>
<style>${WIDGET_STYLE}</style>
</head>
<body>
<div id="root" aria-live="polite"></div>
<script>
(function () {
${WIDGET_HELPERS}
  function card(e) {
    var title = e.title || "";
    var detailPrompt = t("Vis detaljer om «" + title + "» på Opplevagent", "Show details for \\u201c" + title + "\\u201d on Opplevagent");
    var url = pageUrl(e);
    return '<div class="card">' +
      "<h3>" + esc(title) + "</h3>" +
      chips([categoryLabel(e.category), place(e), price(e), duration(e),
             typeof e.distance_km === "number" ? e.distance_km + " km" : ""]) +
      '<div class="actions">' +
        '<button type="button" class="primary" data-ask="' + esc(detailPrompt) + '">' + esc(t("Detaljer", "Details")) + "</button>" +
        (url ? '<button type="button" data-href="' + esc(url) + '">opplevagent.no \\u2197</button>' : "") +
      "</div></div>";
  }
  function render() {
    applyTheme();
    var out = currentData();
    if (!out) {
      root.innerHTML = '<p class="muted">' + esc(t("Henter opplevelser\\u2026", "Loading experiences\\u2026")) + "</p>";
      fitHeight();
      return;
    }
    var list = Array.isArray(out.experiences) ? out.experiences : [];
    if (!list.length) {
      root.innerHTML = '<p class="muted">' + esc(t("Ingen opplevelser passet søket.", "No experiences matched this search.")) + "</p>";
      fitHeight();
      return;
    }
    var shown = state.showAll ? list : list.slice(0, ${LIST_PREVIEW_COUNT});
    var html = "";
    if (Array.isArray(out.relaxed_filters) && out.relaxed_filters.length) {
      html += '<p class="muted">' + esc(t("Ingen eksakte treff \\u2014 noen filtre ble løsnet.", "No exact matches \\u2014 some filters were relaxed.")) + "</p>";
    }
    for (var i = 0; i < shown.length; i++) html += card(shown[i]);
    if (shown.length < list.length) {
      html += '<button type="button" data-more="1">' + esc(t("Vis alle " + list.length, "Show all " + list.length)) + "</button>";
    }
    root.innerHTML = html;
    fitHeight();
  }
  start();
})();
</script>
</body>
</html>`;

export const EXPERIENCE_DETAIL_HTML = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opplevagent</title>
<style>${WIDGET_STYLE}</style>
</head>
<body>
<div id="root" aria-live="polite"></div>
<script>
(function () {
${WIDGET_HELPERS}
  var SEASONS = { winter: ["vinter", "winter"], vinter: ["vinter", "winter"], summer: ["sommer", "summer"], sommer: ["sommer", "summer"],
                  spring: ["vår", "spring"], "vår": ["vår", "spring"], vaar: ["vår", "spring"],
                  autumn: ["høst", "autumn"], "høst": ["høst", "autumn"], host: ["høst", "autumn"],
                  year_round: ["hele året", "all year"], all_year: ["hele året", "all year"] };
  function seasons(list) {
    if (!Array.isArray(list)) return "";
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var s = SEASONS[String(list[i]).toLowerCase()];
      var label = s ? t(s[0], s[1]) : String(list[i]);
      if (!seen[label]) { seen[label] = true; out.push(label); }
    }
    return out.join(" \\u00b7 ");
  }
  function render() {
    applyTheme();
    var e = currentData();
    if (!e) {
      root.innerHTML = '<p class="muted">' + esc(t("Henter opplevelsen\\u2026", "Loading experience\\u2026")) + "</p>";
      fitHeight();
      return;
    }
    if (!e.title) {
      root.innerHTML = '<p class="muted">' + esc(t("Fant ikke denne opplevelsen.", "This experience could not be found.")) + "</p>";
      fitHeight();
      return;
    }
    var io = e.indoor_outdoor === "indoor" ? t("Innendørs", "Indoor")
           : e.indoor_outdoor === "outdoor" ? t("Utendørs", "Outdoor")
           : e.indoor_outdoor === "both" ? t("Inne og ute", "Indoor & outdoor") : "";
    var url = pageUrl(e);
    // A booking URL with a query string is left to the opplevagent.no page
    // (which links it): ChatGPT's iOS app has been reported to drop query
    // parameters from openExternal links, which would land the guest on the
    // wrong page of the provider's booking system.
    var providerUrl = e.booking_url && String(e.booking_url).indexOf("?") === -1 ? e.booking_url : "";
    var html = '<div class="card">' +
      "<h2>" + esc(e.title) + "</h2>" +
      chips([categoryLabel(e.category), place(e), price(e), duration(e), io, seasons(e.season)]) +
      (e.description ? "<p>" + esc(e.description) + "</p>" : "") +
      (e.meeting_point ? '<p class="muted">' + esc(t("Oppmøte: ", "Meeting point: ") + e.meeting_point) + "</p>" : "") +
      '<p class="muted">' + esc(t("Booking og betaling skjer direkte hos tilbyderen.", "Booking and payment happen directly with the provider.")) + "</p>" +
      '<div class="actions">' +
        (providerUrl ? '<button type="button" class="primary" data-href="' + esc(providerUrl) + '">' + esc(t("Til tilbyderen \\u2197", "Go to provider \\u2197")) + "</button>" : "") +
        (url ? '<button type="button" data-href="' + esc(url) + '">opplevagent.no \\u2197</button>' : "") +
      "</div></div>";
    root.innerHTML = html;
    fitHeight();
  }
  start();
})();
</script>
</body>
</html>`;
