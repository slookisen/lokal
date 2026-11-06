// ─── Owner pages: «lagres der du står», steg 2 (eierportal T9) ──────────────
// dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 2, slice T9.
//
// One shared progressive-enhancement script for «Mine valg» (RFB and
// gårdssalg render the same page, owner-features/page.ts). Without
// JavaScript every form still POSTs and the 303 lands on its anchor (T5).
// With JavaScript:
//
//   - a `form[data-mv-row]` / `form[data-mv]` (POST or GET) and an
//     `a[data-mv-row]` link are sent with fetch; the request carries
//     `?fragment=<region-id>,…`, the POST's 303 passes it on to the page GET
//     (anchors.ts ownerFragmentTail), and the GET answers with only those
//     regions (the same render functions as the full page);
//   - a region is replaced only when its markup changed; open <details>
//     stay open; the row stays where it was (manual anchoring: Safari has no
//     CSS scroll anchoring); focus stays on the control or moves to the
//     heading of the panel that opened;
//   - the answer is read from one fixed `#mv-status` (role=status,
//     aria-live=polite), with «Angre» when the change can be undone; an
//     error stands next to the row (role=alert);
//   - «Avbryt» (`a[data-mv-cancel]`) closes its panel on the client;
//   - a second submit while one is running is ignored;
//   - a request that got an HTTP answer is never sent again (FUNN
//     t5-gjeninnsending-ordre-epost: «Send bekreftelse» must not send a second
//     e-mail): a non-ok answer shows the error text. Only when fetch itself
//     failed (no answer) does the form fall back to the plain submission, and
//     never for a form marked `data-mv-once` (the order address) or while
//     the browser says it is offline.
//
// No inline event handlers (CSP `script-src-attr 'none'`): one listener on
// the page. The texts are the spec's («Tekst», punkt 2).

export const OWNER_ENHANCE_TEXTS = {
  saving: "Lagrer …",
  switchOn: "Lagret: «{valg}» er slått på.",
  switchOff: "Lagret: «{valg}» er slått av.",
  level: "Du bruker nå «{nivå}».",
  undo: "Angre",
  undone: "Endringen er angret.",
  noChange: "Ingen endring – valget var allerede slik.",
  failed: "Klarte ikke å lagre. Prøv igjen.",
  network: "Fikk ikke kontakt. Sjekk nettet og prøv igjen.",
  tooMany: "For mange endringer. Prøv igjen om litt.",
} as const;

/** The response header a fragment answer carries (the script checks it). */
export const OWNER_FRAGMENT_HEADER = "X-Mv-Fragment";

/** The live region the script writes its answer to. Rendered once, inside .mv-page. */
export const OWNER_STATUS_HTML = `<div id="mv-status" class="mv-live" role="status" aria-live="polite"></div>`;

export const OWNER_STATUS_CSS = `
  #mv-status { position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 20; max-width: 560px; margin: 0 auto; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 14px; border-radius: 10px; font-size: 0.95rem; background: var(--ow-ok-bg); color: var(--ow-ok-text); border: 1px solid var(--ow-ok-line); box-shadow: 0 2px 10px rgba(0,0,0,0.15); }
  #mv-status:empty { padding: 0; border: 0; box-shadow: none; background: none; }
  #mv-status .mv-ctl-form { margin: 0; }
  .mv-page [aria-busy="true"] { opacity: 0.7; }
`;

const SCRIPT_BODY = `
(function () {
  var T = __TEXTS__;
  if (!window.fetch || !window.DOMParser || !window.FormData || !window.URLSearchParams) return;
  var page = document.querySelector(".mv-page");
  if (!page) return;
  var status = document.getElementById("mv-status");
  var REGIONS = "#niva, section.mv-group, #planlagt, #endringslogg, #mv-toast-slot";
  var busy = false;
  var lastAt = null;

  function fill(s, k, v) { return s.split("{" + k + "}").join(v); }
  function closest(el, sel) {
    while (el && el.nodeType === 1) { if (el.matches(sel)) return el; el = el.parentNode; }
    return null;
  }
  function regionOf(el) { return closest(el, REGIONS); }
  function anchorOf(el) {
    var row = closest(el, "li[id]");
    if (row && page.contains(row)) return row;
    var reg = regionOf(el);
    return reg && reg.id ? reg : null;
  }
  function allRegionIds() {
    var out = [], els = page.querySelectorAll(REGIONS);
    for (var i = 0; i < els.length; i++) if (els[i].id) out.push(els[i].id);
    return out;
  }
  function addId(list, id) { if (id && list.indexOf(id) < 0) list.push(id); }
  function withFragment(url, ids) {
    var u = url.split("#")[0];
    return u + (u.indexOf("?") < 0 ? "?" : "&") + "fragment=" + ids.join(",");
  }
  function queryOf(url) {
    var q = (url || "").split("#")[0].split("?")[1] || "";
    try { return new URLSearchParams(q); } catch (e) { return new URLSearchParams(""); }
  }
  function textOf(el) { return el ? String(el.textContent || "").replace(/\\s+/g, " ").trim() : ""; }
  function say(text, undoForm) {
    if (!status) return;
    while (status.firstChild) status.removeChild(status.firstChild);
    if (!text) return;
    var span = document.createElement("span");
    span.textContent = text;
    status.appendChild(span);
    if (undoForm) status.appendChild(undoForm);
  }
  function clearErrors() {
    var old = page.querySelectorAll("[data-mv-error]");
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
  }
  function showError(at, text) {
    say("", null);
    var box = document.createElement("div");
    box.className = "mv-toast mv-toast-inline mv-toast-error";
    box.setAttribute("role", "alert");
    box.setAttribute("data-mv-error", "1");
    box.textContent = text;
    (at || page).appendChild(box);
  }
  function setBusy(src, on) {
    var btns = src.tagName === "FORM" ? src.querySelectorAll("button, input[type=submit]") : [];
    for (var i = 0; i < btns.length; i++) btns[i].disabled = on;
    if (on) src.setAttribute("aria-busy", "true"); else src.removeAttribute("aria-busy");
  }
  function focusable(el) {
    if (!el) return null;
    return el.querySelector(".mv-item-ctl button, .mv-item-ctl select, .mv-item-ctl input:not([type=hidden]), .mv-item-ctl a[href]");
  }
  function focusHeading(h) {
    if (!h) return false;
    if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
    h.focus();
    return true;
  }
  /** Copy the user's open/closed <details> onto the new region. */
  function keepOpen(cur, next) {
    if (cur.tagName === "DETAILS" && cur.open) next.setAttribute("open", "");
    var a = cur.getElementsByTagName("details"), b = next.getElementsByTagName("details");
    if (a.length !== b.length) return;
    for (var i = 0; i < a.length; i++) {
      if (a[i].open) b[i].setAttribute("open", "");
      else if (/(^|\\s)mv-fold(\\s|$)/.test(a[i].className)) b[i].removeAttribute("open");
    }
  }
  /** Replace the regions whose markup changed; returns true when any did. */
  function swapRegions(doc, ids) {
    var changed = false;
    for (var i = 0; i < ids.length; i++) {
      var cur = document.getElementById(ids[i]), next = doc.getElementById(ids[i]);
      if (!cur || !next) continue;
      keepOpen(cur, next);
      var imported = document.importNode(next, true);
      if (cur.isEqualNode(imported)) continue;
      cur.parentNode.replaceChild(imported, cur);
      changed = true;
    }
    return changed;
  }
  /** A plain GET of the page at its anchor (never a POST again). */
  function go(url, anchorId) {
    var q = queryOf(url);
    q.delete("fragment");
    var base = url.split("#")[0].split("?")[0], qs = q.toString();
    location.assign(base + (qs ? "?" + qs : "") + (anchorId ? "#" + anchorId : ""));
  }
  function nativeSubmit(f) { HTMLFormElement.prototype.submit.call(f); }
  function kindOf(action) { var m = /\\/valg\\/([a-z-]+)(\\?|$)/.exec(action || ""); return m ? m[1] : "get"; }
  function fieldOf(f, name) { var el = f.querySelector("input[type=hidden][name=" + name + "]"); return el ? el.value : null; }
  function labelOfRow(key) { var row = document.getElementById("valg-" + key); return textOf(row && row.querySelector(".mv-item-text strong")); }
  function labelOfLevel(key) {
    var cards = page.querySelectorAll("li[data-level]");
    for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute("data-level") === key) return textOf(cards[i].querySelector("strong"));
    return key;
  }
  /** What the status says after a save (null = mirror the server's message). */
  function answerFor(kind, f, q, before) {
    var melding = q.get("melding") || "";
    if (melding === "ingen_endring") return T.noChange;
    if (melding === "angret" || (kind === "angre" && q.get("endret"))) return T.undone;
    if (kind === "niva" && (q.get("endret") || melding === "niva_valgt")) return fill(T.level, "nivå", before.level || "");
    if (kind === "sett" && q.get("endret") && before.label && (before.value === "true" || before.value === "false") && before.isSwitch) {
      return fill(before.value === "true" ? T.switchOn : T.switchOff, "valg", before.label);
    }
    return null;
  }
  function announce(kind, f, q, before) {
    var toast = page.querySelector(".mv-toast:not([data-mv-error])");
    if (toast && /(^|\\s)mv-toast-error(\\s|$)/.test(toast.className)) { say("", null); return; }
    if (!toast) {
      var fixed = answerFor(kind, f, q, before);
      say(fixed || "", null);
      return;
    }
    var undo = toast.querySelector("form");
    if (undo) { undo.setAttribute("data-mv", "angre"); if (lastAt) undo.setAttribute("data-mv-at", lastAt); }
    var text = answerFor(kind, f, q, before) || textOf(toast.querySelector("span")) || textOf(toast);
    toast.parentNode.removeChild(toast);
    say(text, undo);
  }
  function settle(kind, src, atId, q) {
    var at = atId ? document.getElementById(atId) : null;
    var panel = at && (at.querySelector("[data-confirm-key] h3") || at.querySelector("#niva-forhandsvis h3"));
    if (panel && focusHeading(panel)) return;
    if (document.activeElement && document.activeElement !== document.body && page.contains(document.activeElement)) return;
    var ctl = focusable(at);
    if (ctl) { ctl.focus(); return; }
    var reg = at && (at.matches(REGIONS) ? at : regionOf(at));
    focusHeading(reg && reg.querySelector("h2"));
  }

  function send(src, method, url, body, kind) {
    var anchor = anchorOf(src);
    var atId = src.getAttribute("data-mv-at") || (anchor && anchor.id) || null;
    if (src.parentNode === status || closest(src, "#mv-status")) atId = src.getAttribute("data-mv-at") || lastAt;
    var at = atId ? document.getElementById(atId) : null;
    var top = at ? at.getBoundingClientRect().top : null;
    var f = src.tagName === "FORM" ? src : null;
    var before = {
      label: f ? labelOfRow(fieldOf(f, "key") || "") : "",
      value: f ? fieldOf(f, "value") : null,
      isSwitch: !!(f && fieldOf(f, "key") && !f.querySelector("select, input[type=text], input[type=number], input[type=email]")),
      level: f && kind === "niva" ? labelOfLevel(fieldOf(f, "level") || "") : ""
    };
    var ids;
    if (method === "POST") ids = allRegionIds();
    else {
      ids = [];
      addId(ids, src.getAttribute("data-mv-row"));
      var stale = page.querySelectorAll(".mv-toast, .mv-confirm");
      for (var i = 0; i < stale.length; i++) { var r = regionOf(stale[i]); if (r) addId(ids, r.id); }
      addId(ids, "mv-toast-slot");
    }
    busy = true;
    lastAt = atId;
    setBusy(src, true);
    clearErrors();
    if (method === "POST") say(T.saving, null);
    var init = { method: method, credentials: "same-origin" };
    if (method === "POST") { init.headers = { "Content-Type": "application/x-www-form-urlencoded" }; init.body = body; }
    fetch(withFragment(url, ids), init).then(function (r) {
      return r.text().then(function (t) { return { r: r, html: t }; }, function () { return { r: r, html: "" }; });
    }, function () { return null; }).then(function (out) {
      busy = false;
      setBusy(src, false);
      if (!out) {
        // No answer at all: the plain submission (GET, or a POST that is safe to repeat).
        if (method === "GET") { go(url, atId); return; }
        if ((f && f.hasAttribute("data-mv-once")) || navigator.onLine === false) { showError(at, T.network); return; }
        say("", null);
        nativeSubmit(f);
        return;
      }
      var ok = out.r.ok && !!out.r.headers.get("__HEADER__");
      if (!ok) {
        // The server answered: never send it again. A 303 that was followed (the
        // POST was handled) but whose regions could not be read → a plain GET
        // of the page at the anchor shows what was saved.
        if (out.r.redirected) { go(out.r.url, atId); return; }
        showError(at, out.r.status === 429 ? T.tooMany : T.failed);
        return;
      }
      var doc = new DOMParser().parseFromString("<!doctype html><body>" + out.html, "text/html");
      var q = queryOf(out.r.url);
      swapRegions(doc, ids);
      var now = atId ? document.getElementById(atId) : null;
      if (now && top !== null) {
        var delta = now.getBoundingClientRect().top - top;
        if (delta) window.scrollBy(0, delta);
      }
      announce(kind, f, q, before);
      settle(kind, src, atId, q);
    });
  }

  page.addEventListener("submit", function (ev) {
    var f = ev.target;
    if (!f || f.tagName !== "FORM" || !(f.hasAttribute("data-mv-row") || f.hasAttribute("data-mv"))) return;
    ev.preventDefault();
    if (busy) return;
    var method = String(f.getAttribute("method") || "get").toUpperCase() === "POST" ? "POST" : "GET";
    var params = new URLSearchParams(new FormData(f)).toString();
    if (method === "POST") send(f, "POST", f.action, params, kindOf(f.action));
    else send(f, "GET", f.action.split("#")[0].split("?")[0] + (params ? "?" + params : ""), null, "get");
  });
  page.addEventListener("click", function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = closest(ev.target, "a[data-mv-cancel], a[data-mv-row]");
    if (!a) return;
    ev.preventDefault();
    if (a.hasAttribute("data-mv-cancel")) {
      var panel = closest(a, ".mv-confirm");
      var row = panel && (closest(panel, "li[id]") || regionOf(panel));
      if (panel) panel.parentNode.removeChild(panel);
      clearErrors();
      var ctl = focusable(row);
      if (ctl) ctl.focus(); else focusHeading(row && row.querySelector("h2"));
      return;
    }
    if (busy) return;
    send(a, "GET", a.href, null, "get");
  });
})();
`;

/** The script, with the texts and the header name filled in. */
export const OWNER_ENHANCE_SCRIPT = SCRIPT_BODY
  .replace("__TEXTS__", () => JSON.stringify(OWNER_ENHANCE_TEXTS))
  .replace("__HEADER__", () => OWNER_FRAGMENT_HEADER);
