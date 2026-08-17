/**
 * render-page.test.ts — unit tests for the headless-render fallback
 * (services/render-page.ts).
 *
 * Every escalation case is anchored to a REAL measured page, so a future
 * change to the threshold is a reviewed decision rather than a silent
 * regression:
 *
 *   67northdistillery.no  179 883 B  →   19 visible chars, 10 <script>  ESCALATE
 *   hamre-hagen.no         12 341 B  →  305 visible chars               no
 *   vestre-bjolsund.no        152 B  →  152 visible chars, no markup    no
 *
 * The invariant these tests protect: `renderer_unavailable` must never be
 * confused with a site-side failure. Production runs on Alpine with no
 * browser, so every production call returns that reason — if it were
 * indistinguishable from "the site is empty", the pipeline would start
 * recording false verdicts against live producers on every run.
 *
 * The whole file is browser-free by construction: renderPage() takes an
 * injected renderImpl. `npm test` must never require Chromium.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/render-page.test.ts
 *   2. Wired into the gate: tests/test.ts imports runRenderPageTests().
 */

import {
  RENDER_ESCALATION_MAIN_CONTENT_TEXT_FLOOR,
  RENDER_ESCALATION_MIN_BYTES,
  RENDER_ESCALATION_TEXT_FLOOR,
  classifyRenderError,
  mainContentTextOf,
  renderPage,
  renderedTextOf,
  selectRenderBackend,
  shouldEscalateToRender,
} from "./render-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const UA = "Lokal-Test/1.0";

/** A JS-shell page in the shape of 67 North: big, scripted, almost no text. */
function jsShell(visibleText: string, padBytes = 8_000): string {
  const pad = `<div data-x="${"a".repeat(padBytes)}"></div>`;
  return `<!doctype html><html><head><title>${visibleText}</title>` +
    `<script src="/app.js"></script><script>window.__N={};</script></head>` +
    `<body><div id="root"></div>${pad}</body></html>`;
}

export async function runRenderPageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  const check = (cond: boolean, label: string) => {
    if (cond) {
      passed++;
      if (log) console.log(`    ok  ${label}`);
    } else {
      failed++;
      failures.push(label);
      if (log) console.log(`    FAIL ${label}`);
    }
  };

  // ── shouldEscalateToRender: the three real measured shapes ────────────────

  // 67 North: 180 KB, 19 visible chars, scripts present.
  const sixtySeven = jsShell("67 North Distillery", 170_000);
  check(
    shouldEscalateToRender(sixtySeven),
    "esc-1: the 67 North shape (big, scripted, 19 visible chars) escalates",
  );

  // hamre-hagen.no: a real server-rendered producer page, 305 visible chars.
  const realPage =
    `<!doctype html><html><head><title>Hamre Hagen</title><script src="/a.js"></script></head><body>` +
    `<p>${"Velkommen til Hamre Hagen. ".repeat(14)}</p>` +
    `<div data-x="${"a".repeat(9_000)}"></div></body></html>`;
  check(
    renderedTextOf(realPage).length > RENDER_ESCALATION_TEXT_FLOOR,
    "esc-2: fixture sanity — the real-page fixture is above the escalation floor",
  );
  check(
    !shouldEscalateToRender(realPage),
    "esc-3: a real server-rendered page with 300+ visible chars does NOT escalate",
  );

  // vestre-bjolsund.no: a 152-byte plain-text error stub. Below the byte floor.
  const stub = "Database connection error. Please try again later.";
  check(
    !shouldEscalateToRender(stub),
    "esc-4: a tiny error stub does not escalate (byte floor) — no browser launch wasted on it",
  );

  // The og:description-only producer site fetch-page.ts documents: 20 visible
  // chars, but NO script. Running a browser cannot invent text that is not
  // there, so escalating would be pure waste.
  const noScript =
    `<!doctype html><html><head><meta property="og:description" content="Ein liten gard i Hardanger"></head>` +
    `<body><p>Velkomen til garden.</p><div data-x="${"a".repeat(5_000)}"></div></body></html>`;
  check(
    renderedTextOf(noScript).length < RENDER_ESCALATION_TEXT_FLOOR,
    "esc-5: fixture sanity — the no-script page is genuinely below the floor",
  );
  check(
    !shouldEscalateToRender(noScript),
    "esc-6: a script-free page never escalates, however thin — a browser adds nothing",
  );

  // Boundary: exactly at the byte floor with a script and no text.
  const atByteFloor = jsShell("x", RENDER_ESCALATION_MIN_BYTES);
  check(
    shouldEscalateToRender(atByteFloor, { bytes: RENDER_ESCALATION_MIN_BYTES }),
    "esc-7: a page at exactly the byte floor escalates (floor is inclusive)",
  );
  check(
    !shouldEscalateToRender(atByteFloor, { bytes: RENDER_ESCALATION_MIN_BYTES - 1 }),
    "esc-8: one byte under the floor does not escalate — the caller's byte count wins over the string length",
  );

  // ── mainContentTextOf: boilerplate stripping, direct unit tests ───────────

  {
    const boilerChrome =
      "<nav>NAVLINK1 NAVLINK2</nav>" +
      "<header>SITE HEADER TEXT</header>" +
      '<div role="banner">ROLE BANNER TEXT</div>' +
      '<div class="cookie-consent-banner">COOKIE TEXT</div>' +
      "<footer>FOOTER TEXT</footer>" +
      "<main>REAL CONTENT HERE</main>";
    check(
      mainContentTextOf(boilerChrome) === "REAL CONTENT HERE",
      "mct-1: nav/header/role-banner/cookie-banner/footer are all stripped; the real <main> text survives untouched",
    );
  }

  // ── mainContentTextOf: Finding 2 (independent-reviewer fix-up) ────────────
  // Substring keyword matching risked stripping REAL farm-shop content that
  // merely happens to contain a chrome keyword as a fragment of an unrelated
  // word. Each fixture below is a realistic gårdssalg/producer element that
  // must now SURVIVE mainContentTextOf() — the tightened rule requires a
  // whole class/id token equal to a small safe bare-word set, or a genuine
  // hyphenated compound (e.g. "cookie-consent"), not a bare substring.
  {
    const hamburgerProductFixture =
      "<nav>Hjem Om Kontakt</nav>" +
      '<div id="hamburger-info">Vi selger hjemmelaget hamburgerkjøtt fra eget storfe, 100% norsk kjøttdeig rett fra garden.</div>' +
      "<footer>© 2026 Gard AS</footer>";
    check(
      mainContentTextOf(hamburgerProductFixture).includes("hamburgerkjøtt fra eget storfe"),
      'mct-fp-1: id="hamburger-info" (a real meat product) survives — bare "hamburger" substring is no longer enough to strip real content',
    );
  }
  {
    const cookieJarProductFixture =
      "<nav>Hjem Om Kontakt</nav>" +
      '<div class="cookie-jar-produkter">Våre hjemmelagde cookies selges i syltetøyglass rett fra gardsbutikken, med smaker som havre og sjokolade.</div>' +
      "<footer>© 2026 Gard AS</footer>";
    check(
      mainContentTextOf(cookieJarProductFixture).includes("hjemmelagde cookies selges"),
      'mct-fp-2: class="cookie-jar-produkter" (real baked-goods content) survives — bare "cookie" substring is no longer enough to strip real content',
    );
  }
  {
    const sidebarHoursFixture =
      "<nav>Hjem Om Kontakt</nav>" +
      '<div class="sidebar">Åpningstider: Mandag-fredag 10-17, lørdag 10-14. Gardsutsalget ligger ved låven.</div>' +
      "<footer>© 2026 Gard AS</footer>";
    check(
      mainContentTextOf(sidebarHoursFixture).includes("Åpningstider"),
      'mct-fp-3: class="sidebar" (a real opening-hours widget — very common on small producer sites) survives — bare "sidebar" is no longer enough to strip real content',
    );
  }
  {
    // The tightened rule must not have gone too far the other way: genuine
    // compound/whole-token chrome signals are still stripped as before.
    const compoundChromeFixture =
      '<div class="navbar">NAVBAR LINKS</div>' +
      '<div class="hamburger-menu">MENU TOGGLE ICON</div>' +
      '<div class="nav-sidebar">SIDEBAR NAV LINKS</div>' +
      '<div class="gdpr-consent-notice">ACCEPT COOKIES</div>' +
      "<main>REAL CONTENT</main>";
    check(
      mainContentTextOf(compoundChromeFixture) === "REAL CONTENT",
      "mct-fp-4: genuine compound/whole-token chrome (navbar, hamburger-menu, nav-sidebar, gdpr-consent-notice) is still stripped — Finding 2's tightening does not weaken true-positive detection",
    );
  }

  // ── mainContentTextOf / shouldEscalateToRender: Finding 1 (independent-
  // reviewer fix-up) — quadratic-time DoS regression guard ──────────────────
  //
  // Reproduces the reviewer's concrete PoC shape: real prose + one <script>
  // tag + tens of thousands of an OPENING tag that matches the class/id
  // keyword clause with NO closing tag anywhere in the document (realistic
  // malformed/buggy producer-CMS HTML, not even adversarial). Pre-fix, the
  // reviewer measured 15.8s for a 1.29 MB payload of this shape through the
  // real shouldEscalateToRender() call path; this asserts a strict wall-
  // clock budget so a future regression to the old backreference-scan
  // approach is caught by CI, not just eyeballed.
  {
    const unclosedCount = 60_000;
    const prose = "Velkommen til garden vår, ekte norske gardsprodukter siden 1970. ".repeat(5);
    let chromeBomb = "";
    for (let i = 0; i < unclosedCount; i++) {
      chromeBomb += '<div class="cookie-x">';
    }
    const pathological =
      `<!doctype html><html><head><title>Gard</title><script src="/app.js"></script></head><body>` +
      prose +
      chromeBomb +
      `</body></html>`;
    const pathologicalBytes = Buffer.byteLength(pathological);

    const mctStart = Date.now();
    const mctResult = mainContentTextOf(pathological);
    const mctElapsedMs = Date.now() - mctStart;
    check(
      typeof mctResult === "string",
      "perf-1-sanity: mainContentTextOf still returns a string for the pathological (60k unclosed chrome divs) input",
    );
    check(
      mctElapsedMs < 500,
      `perf-1: mainContentTextOf() on a ${(pathologicalBytes / 1_000_000).toFixed(2)} MB payload of ${unclosedCount} unclosed <div class="cookie-x"> tags completes in ${mctElapsedMs}ms, well under the 500ms budget (reviewer measured 15.8s pre-fix on a same-shaped 1.29 MB payload) — Finding 1 regression guard`,
    );

    const escStart = Date.now();
    shouldEscalateToRender(pathological);
    const escElapsedMs = Date.now() - escStart;
    check(
      escElapsedMs < 500,
      `perf-2: shouldEscalateToRender() on the same pathological payload — the real call path every fetched hjemmeside page goes through — completes in ${escElapsedMs}ms, under the 500ms budget`,
    );
  }

  // ── shouldEscalateToRender: Skive 2a — boilerplate-aware eligibility ──────
  // dev-request 2026-08-17-berikelse-uttrekk-evidence-url-og-render.
  //
  // Fixture shaped like the real measured case: nav + footer + a
  // cookie-consent banner alone add up to ~1.8K characters of raw "visible
  // text" (well above RENDER_ESCALATION_TEXT_FLOOR), but strip that chrome
  // out and what's left is just the page title — a handful of characters.
  // Zero real content, same as the live row that inspired this fix.
  const navChrome =
    "<nav>" +
    '<a href="/">Hjem</a> <a href="/om">Om oss</a> <a href="/produkter">Produkter</a> <a href="/kontakt">Kontakt</a> '.repeat(
      15,
    ) +
    "</nav>";
  const footerChrome =
    "<footer>" +
    "© 2026 Gard AS. Følg oss i sosiale medier. Meld deg på nyhetsbrevet vårt for oppdateringer. ".repeat(8) +
    "</footer>";
  const cookieBanner =
    '<div class="cookie-consent-banner">' +
    "Vi bruker informasjonskapsler for å forbedre opplevelsen din på nettsiden. Godta eller avvis. ".repeat(6) +
    "</div>";
  const jsShellBoilerplate =
    `<!doctype html><html><head><title>Gard</title><script src="/app.js"></script></head><body>` +
    navChrome +
    `<div id="root"></div>` +
    footerChrome +
    cookieBanner +
    `<script>window.__STATE__={};</script></body></html>`;

  check(
    Buffer.byteLength(jsShellBoilerplate) >= RENDER_ESCALATION_MIN_BYTES,
    "esc-9-sanity-a: the boilerplate-heavy fixture clears the byte floor on its own (no artificial padding needed)",
  );
  check(
    renderedTextOf(jsShellBoilerplate).length >= RENDER_ESCALATION_TEXT_FLOOR,
    "esc-9-sanity-b: fixture sanity — the RAW visible-text length alone is already >= the raw floor (200), so only the boilerplate-aware branch can catch this case",
  );
  check(
    mainContentTextOf(jsShellBoilerplate).length < RENDER_ESCALATION_MAIN_CONTENT_TEXT_FLOOR,
    "esc-9-sanity-c: fixture sanity — after stripping nav/footer/cookie-banner chrome, real content is under the main-content floor (400)",
  );
  check(
    shouldEscalateToRender(jsShellBoilerplate),
    "esc-9: a JS shell whose nav/footer/cookie-banner chrome alone pushes raw visible text past the 200-char floor is now judged eligible — the measured 2043-char/zero-fields-extracted case this fix exists for",
  );

  // Regression guard: a genuinely content-rich static page — real prose well
  // past both floors, with only a small, normal amount of nav/footer — must
  // still NOT become eligible. Without the "stripping removed a meaningful
  // chunk" gap requirement, this fixture's ~650 real chars would still sit
  // under some blunt combined floor; the gap check is what keeps it safe.
  const realProseHeavy =
    `<!doctype html><html><head><title>Ekte Gard</title><script src="/analytics.js"></script></head><body>` +
    `<nav><a href="/">Hjem</a> <a href="/kontakt">Kontakt</a></nav>` +
    `<p>${"Velkommen til garden vår, der vi dyrker grønnsaker og bær på tradisjonelt vis. ".repeat(8)}</p>` +
    `<footer>© 2026 Ekte Gard</footer></body></html>`;
  check(
    mainContentTextOf(realProseHeavy).length >= RENDER_ESCALATION_MAIN_CONTENT_TEXT_FLOOR,
    "esc-10-sanity: fixture sanity — the real-prose fixture's content clears the main-content floor even after stripping its (small, normal) nav/footer",
  );
  check(
    !shouldEscalateToRender(realProseHeavy),
    "esc-10: a real content-rich page with ordinary nav/footer does NOT falsely escalate — no regression from the boilerplate-aware branch",
  );

  // Second regression guard, restated explicitly for Skive 2a: the SAME
  // hamre-hagen-shaped real-page fixture from esc-2/esc-3 above (305 real
  // visible chars, effectively no nav/footer to strip) must still not
  // escalate under the new logic — its stripped length is ~= its raw length,
  // so the mandatory "boilerplate actually removed something" gap never
  // opens, and the boilerplate-aware branch never fires for it.
  check(
    !shouldEscalateToRender(realPage),
    "esc-11: the hamre-hagen-shaped short-but-real fixture (no nav/footer to strip) is unaffected by the boilerplate-aware branch — still does not escalate",
  );

  // ── renderPage: success path ──────────────────────────────────────────────

  const okResult = await renderPage("https://67northdistillery.no/", {
    userAgent: UA,
    now: (() => {
      let t = 1_000;
      return () => (t += 500);
    })(),
    renderImpl: async () => ({
      html: "<html><body><h1>67 North Distillery</h1><p>Vi destillerer akevitt i Saltdal.</p></body></html>",
      finalUrl: "https://67northdistillery.no/",
    }),
  });
  check(okResult.ok === true, "rp-1: a successful render reports ok:true");
  check(
    okResult.ok === true && okResult.text.includes("destillerer akevitt"),
    "rp-2: the rendered text carries content the raw HTML never had",
  );
  check(
    okResult.ok === true && !okResult.text.includes("<h1>"),
    "rp-3: markup is stripped from the returned text, not passed through",
  );
  check(okResult.elapsedMs > 0, "rp-4: elapsedMs is reported so render cost is measurable");

  // ── renderPage: the distinction that matters most ─────────────────────────

  const unavailable = await renderPage("https://example.no/", {
    userAgent: UA,
    renderImpl: async () => {
      throw new Error("PLAYWRIGHT_UNAVAILABLE: playwright-core is not installed in this environment");
    },
  });
  check(
    unavailable.ok === false && unavailable.reason === "renderer_unavailable",
    "rp-5: a missing browser reports renderer_unavailable — the production (Alpine) case",
  );

  const emptyAfterRender = await renderPage("https://example.no/", {
    userAgent: UA,
    renderImpl: async () => ({ html: "<html><body><div id=root></div></body></html>", finalUrl: "https://example.no/" }),
  });
  check(
    emptyAfterRender.ok === false && emptyAfterRender.reason === "render_empty",
    "rp-6: a page that renders to nothing reports render_empty",
  );
  check(
    unavailable.ok === false &&
      emptyAfterRender.ok === false &&
      unavailable.reason !== emptyAfterRender.reason,
    "rp-7: renderer_unavailable and render_empty are DISTINCT — a machine without a browser must never be recorded as a producer with an empty site",
  );

  const timedOut = await renderPage("https://example.no/", {
    userAgent: UA,
    renderImpl: async () => {
      const e = new Error("Timeout 20000ms exceeded.");
      e.name = "TimeoutError";
      throw e;
    },
  });
  check(
    timedOut.ok === false && timedOut.reason === "render_timeout",
    "rp-8: a navigation timeout reports render_timeout",
  );

  const navFailed = await renderPage("https://nope.invalid/", {
    userAgent: UA,
    renderImpl: async () => {
      throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/");
    },
  });
  check(
    navFailed.ok === false && navFailed.reason === "render_navigation_failed",
    "rp-9: an in-browser DNS failure reports render_navigation_failed, not unknown",
  );

  // renderPage must never throw, whatever the impl does.
  const weird = await renderPage("https://example.no/", {
    userAgent: UA,
    renderImpl: async () => {
      throw { toString: () => "not an Error" };
    },
  });
  check(
    weird.ok === false && weird.reason === "unknown",
    "rp-10: a non-Error throw is classified as unknown rather than escaping — never a bare crash",
  );

  // ── classifyRenderError is pure and total ─────────────────────────────────
  check(
    classifyRenderError(new Error("Cannot find module 'playwright-core'")).reason === "renderer_unavailable",
    "cre-1: a module-resolution failure is renderer_unavailable, not a site problem",
  );
  check(
    classifyRenderError(new Error("something else entirely")).reason === "unknown",
    "cre-2: an unrecognised error is named unknown rather than guessed at",
  );

  // ── classifyRenderError: render-client.ts's worker-path error shapes ──────
  // These must NOT collapse into renderer_unavailable — once RENDER_WORKER_KEY
  // is configured, a worker failure is a real render failure about that page.
  check(
    classifyRenderError(new Error("render-worker 504: navigation timeout")).reason === "render_timeout",
    "cre-3: a render-worker 504 (the worker's own navigation-timeout status) is render_timeout",
  );
  check(
    classifyRenderError(new Error("render-worker 502: navigation failed")).reason === "render_navigation_failed",
    "cre-4: a render-worker 502 (the worker's own navigation-failed status) is render_navigation_failed",
  );
  {
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    check(
      classifyRenderError(abortErr).reason === "render_timeout",
      "cre-5: an AbortError (render-client.ts's client-side fetch timeout) is render_timeout",
    );
  }
  check(
    classifyRenderError(new Error("render-worker 500: browser not ready")).reason === "unknown",
    "cre-6: a render-worker 500 is a real attempt failure (unknown), never renderer_unavailable",
  );
  check(
    classifyRenderError(new TypeError("fetch failed")).reason === "unknown",
    "cre-7: a generic fetch failure reaching the worker is unknown, not renderer_unavailable",
  );
  check(
    classifyRenderError(new Error("RENDER_WORKER_KEY env var not set; cannot call render-worker")).reason ===
      "renderer_unavailable",
    "cre-8: RENDER_WORKER_KEY vanishing mid-process (the one race case) still reports renderer_unavailable",
  );

  // ── selectRenderBackend: pure, env-only ────────────────────────────────────
  {
    const prevKey = process.env.RENDER_WORKER_KEY;
    try {
      process.env.RENDER_WORKER_KEY = "wk_live_test_key";
      check(selectRenderBackend() === "worker", "srb-1: worker wins whenever RENDER_WORKER_KEY is set (the prod case)");

      delete process.env.RENDER_WORKER_KEY;
      check(selectRenderBackend() === "local", "srb-2: local is the fallback when RENDER_WORKER_KEY is unset (dev/sandbox)");

      process.env.RENDER_WORKER_KEY = "";
      check(selectRenderBackend() === "local", "srb-3: an empty-string key is treated the same as unset — falsy, not configured");
    } finally {
      if (prevKey === undefined) delete process.env.RENDER_WORKER_KEY;
      else process.env.RENDER_WORKER_KEY = prevKey;
    }
  }

  return { passed, failed, failures };
}

// Standalone runner
if (process.argv[1] && process.argv[1].endsWith("render-page.test.ts")) {
  runRenderPageTests({ log: true }).then((r) => {
    console.log(`\nrender-page: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
