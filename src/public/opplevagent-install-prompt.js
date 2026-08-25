/**
 * opplevagent-install-prompt.js — minimal "Add to home screen" install-prompt
 * UX for the opplevagent.no host (Opplevagent).
 *
 * dev-request 2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering: extends
 * the already-shipped rfb-only PWA rollout (dev-request
 * 2026-07-04-app-strategi-pwa, slice 3 of 3, PRs #225/#245 — see
 * src/public/install-prompt.js) to opplevagent.no. Same button/prompt logic
 * as src/public/install-prompt.js, copied rather than reinvented, with only
 * the button color changed from rfb's forest green (#2D5016) to
 * opplevagent's coral (#ff5d3b) — and the focus-outline color changed from
 * rfb's gold (#ffd166) to opplevagent's dark teal (#0c7264, already used
 * elsewhere in experiences-seo.ts's legal-page styling) for better contrast
 * against this site's light cream (#f7f4ee) page background: gold-on-cream
 * is a low-contrast pairing, whereas the dark teal reads clearly as a focus
 * ring on every page background this button can appear over.
 *
 * Served via GET /install-prompt.js from src/routes/experiences-seo.ts
 * (this file is NOT reachable through express.static — see that route's
 * doc comment / src/public/opplevagent-sw.js's for why).
 *
 * Plain vanilla browser script, no build step. Uses the standard
 * `beforeinstallprompt` event, which only exists on Chromium-based browsers
 * (Chrome/Edge/Android). It does NOT exist on iOS Safari — iOS
 * installability is already covered by the manifest + icons via the native
 * Share-sheet, so this file deliberately does not build any iOS-specific
 * banner/instructions.
 *
 * Exposes `shouldShowInstallButton` as a small pure function (guarded by a
 * dual CommonJS/browser export) so it is unit-testable from Node without a
 * DOM — see src/public/opplevagent-install-prompt.test.ts.
 */
(function () {
  "use strict";

  var BUTTON_ID = "pwa-install-btn";

  /**
   * Pure guard: should the install button ever be shown?
   * False when the app is already running as an installed PWA
   * (display-mode: standalone) — matches the spec: "never show the button
   * at all" in that case.
   *
   * Accepts an injectable `win` (defaults to the global `window`) so it can
   * be unit-tested with a fake matchMedia implementation.
   */
  function shouldShowInstallButton(win) {
    var target = win || (typeof window !== "undefined" ? window : undefined);
    if (!target || typeof target.matchMedia !== "function") {
      // No matchMedia available (e.g. very old browser, or no DOM at all) —
      // fail open, since we can't prove we're already installed.
      return true;
    }
    try {
      return !target.matchMedia("(display-mode: standalone)").matches;
    } catch (err) {
      return true;
    }
  }

  // Dual export: CommonJS (Node, for unit tests) + browser global, without
  // requiring a bundler.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { shouldShowInstallButton: shouldShowInstallButton };
  }

  // Browser-only wiring below. Guarded so this file is also safely
  // `require()`-able from a plain Node test runner (no `window`/`document`).
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  if (!shouldShowInstallButton(window)) {
    // Already installed / running standalone — never show the button.
    return;
  }

  var deferredPrompt = null;
  var btn = null;

  function createButton() {
    var b = document.createElement("button");
    b.id = BUTTON_ID;
    b.type = "button";
    b.textContent = "Legg til på hjemskjerm";
    b.setAttribute("aria-label", "Legg til på hjemskjerm");
    b.style.cssText = [
      "display:none",
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483000",
      "padding:10px 16px",
      "background:#ff5d3b",
      "color:#fff",
      "border:2px solid transparent",
      "border-radius:999px",
      "font-size:14px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "box-shadow:0 2px 8px rgba(0,0,0,0.25)",
      "cursor:pointer"
    ].join(";");
    b.addEventListener("focus", function () {
      b.style.outline = "3px solid #0c7264";
      b.style.outlineOffset = "2px";
    });
    b.addEventListener("blur", function () {
      b.style.outline = "";
      b.style.outlineOffset = "";
    });
    b.addEventListener("click", onInstallClick);
    document.body.appendChild(b);
    return b;
  }

  function showButton() {
    if (!btn) btn = createButton();
    btn.style.display = "block";
  }

  function hideButton() {
    if (btn) btn.style.display = "none";
  }

  function onInstallClick() {
    if (!deferredPrompt) return;
    var promptEvent = deferredPrompt;
    // A beforeinstallprompt event can only be used once — grab a local
    // reference, then null the stash so a stray double-click can't reuse it
    // while we're awaiting userChoice below.
    deferredPrompt = null;
    promptEvent.prompt();
    promptEvent.userChoice.then(hideButton, hideButton);
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredPrompt = event;
    showButton();
  });

  window.addEventListener("appinstalled", function () {
    // Covers installing via the browser's own UI instead of our button.
    // Nothing sensitive logged.
    deferredPrompt = null;
    hideButton();
  });
})();
