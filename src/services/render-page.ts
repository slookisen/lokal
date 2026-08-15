/**
 * Headless-browser rendering fallback for JS-built producer sites.
 *
 * Why this module exists (Daniel, live session 2026-08-13). The shared fetcher
 * (services/fetch-page.ts) reads raw HTML. That is correct and cheap for the
 * overwhelming majority of Norwegian producer sites, but it returns nothing
 * usable for a site whose content is assembled in the browser. The case that
 * forced this, measured the same day:
 *
 *   67northdistillery.no   179 883 B HTML   →   19 visible chars   10 <script>
 *
 * Nineteen characters — the page title, "67 North Distillery", and nothing
 * else. The row sits in `needs_enrichment` because `about_text` and `products`
 * are empty, and they are empty because THERE IS NO TEXT TO EXTRACT from the
 * source. No amount of re-running the existing enrichment chain fixes that;
 * the content only exists after JavaScript runs.
 *
 * Contrast with a real server-rendered producer page from the 2026-07-26 probe
 * recorded in fetch-page.ts:
 *
 *   hamre-hagen.no          12 341 B HTML   →  305 visible chars
 *
 * That two-orders-of-magnitude gap in text-per-byte is what shouldEscalate-
 * ToRender() below keys on.
 *
 * ── Contract ───────────────────────────────────────────────────────────────
 *
 * Same discipline as fetch-page.ts, deliberately: NEVER a bare null. Every
 * failure comes back as a named reason. A caller must be able to tell "no
 * browser is installed here" apart from "the browser ran and the page was
 * still empty" — those have completely different remedies, and collapsing them
 * is the exact mistake fetch-page.ts exists to document.
 *
 * ── Deployment note, load-bearing ──────────────────────────────────────────
 *
 * This module does NOT add a runtime dependency, and production DOES render —
 * via a backend, not via a bundled browser. `defaultRenderImpl` picks that
 * backend with `selectRenderBackend()`, keyed on whether `RENDER_WORKER_KEY`
 * is configured:
 *
 *   - "worker" (production, and any environment with the key set): the
 *     render is delegated to `render-worker/`, the standalone, already-live
 *     `lokal-render-worker` Fly app (own image, built on
 *     `mcr.microsoft.com/playwright`, own autoscale-to-zero, own internal
 *     concurrency cap) via `services/render-client.ts`. Nothing is launched
 *     in-process; this app's own memory/image footprint (Dockerfile:
 *     node:20-alpine, 1024 MB, shared-cpu-1x, serving both
 *     rettfrabonden.com and opplevagent.no) is untouched by rendering at all.
 *     A failed call to the worker (bad response, timeout, network error) is
 *     a real render failure for that page/attempt, classified by
 *     `classifyRenderError()` same as the local path below — it is NOT
 *     `renderer_unavailable`, because the worker being reachable in
 *     principle is exactly what "configured" means here.
 *   - "local" (RENDER_WORKER_KEY unset — dev/sandbox only): the original
 *     `playwright-core` path, imported lazily inside a try/catch so merely
 *     loading this module never requires the package to exist. This is what
 *     makes `renderPage()` work in a session container that happens to ship
 *     Chromium at $PLAYWRIGHT_BROWSERS_PATH, and it is kept as a harmless
 *     fallback branch, not the production path. Playwright's own Chromium
 *     builds are glibc-only and do not run on Alpine/musl, so this branch
 *     was never going to be production's answer — apk-installing a system
 *     Chromium into the main image remains out of scope (roughly +400 MB of
 *     image and 150-300 MB more RSS while a page is open, on a machine that
 *     already sits around 286 MB, with no staging environment to catch a
 *     boot failure before real traffic) and is not needed now that the
 *     worker covers production.
 *
 * `renderer_unavailable` is reserved for the genuine case: no worker key AND
 * the local `playwright-core` import fails — this environment has no
 * rendering capability at all.
 *
 * The escalation decision and the backend selection are both PURE and
 * unit-tested; the render itself is the only part here that does I/O.
 */

import { visibleTextOf } from "./fetch-page";
// Distinct local name: render-client.ts independently exports its own
// `renderPage`, unrelated in shape to this module's export of the same name
// — a pre-existing naming collision between two independently-written files.
import { renderPage as callRenderWorker } from "./render-client";

// ── Tunables ────────────────────────────────────────────────────────────────

/** Wall-clock cap for one render, including navigation and settle. */
export const DEFAULT_RENDER_TIMEOUT_MS = 20_000;

/**
 * Visible-character floor under which a fetched page is considered a JS shell
 * worth re-fetching through a browser.
 *
 * 200 sits deliberately between the two measured poles: 67 North's 19 and
 * hamre-hagen's 305. It is a floor for ESCALATION, never for rejection — a
 * page below it is not discarded, it is retried harder. fetch-page.ts refuses
 * to carry any "too thin" threshold because there it would silently hide real
 * pages from the extractors; here the failure mode of a wrong guess is one
 * wasted render, not a lost producer. That asymmetry is why a threshold is
 * acceptable in this module and not in that one.
 */
export const RENDER_ESCALATION_TEXT_FLOOR = 200;

/**
 * Byte floor for escalation. A genuinely tiny response is an error stub, not a
 * JS app — isUnusableBody() already catches the markup-free ones, and this
 * stops the rest from each costing a browser launch.
 */
export const RENDER_ESCALATION_MIN_BYTES = 2_000;

// ── Result types ────────────────────────────────────────────────────────────

export type RenderFailureReason =
  /** No browser/playwright-core in this environment. NOT a site problem. */
  | "renderer_unavailable"
  /** The browser launched but navigation exceeded the timeout. */
  | "render_timeout"
  /** Navigation itself failed (DNS, TLS, refused) inside the browser. */
  | "render_navigation_failed"
  /** The browser rendered the page and it still carried no usable text. */
  | "render_empty"
  | "unknown";

export type RenderPageResult =
  | {
      ok: true;
      /** Serialized DOM AFTER scripts ran. */
      html: string;
      /** Visible text of that DOM, already extracted. */
      text: string;
      finalUrl: string;
      /** Milliseconds the render took, for cost reporting. */
      elapsedMs: number;
    }
  | {
      ok: false;
      reason: RenderFailureReason;
      detail: string;
      elapsedMs: number;
    };

// ── Pure decision ───────────────────────────────────────────────────────────

/**
 * Whether a successfully-fetched page looks like a JS shell worth rendering.
 * PURE — no network, no browser.
 *
 * All three conditions must hold:
 *   1. the visible text is under the escalation floor,
 *   2. the response is big enough to be an application rather than a stub, and
 *   3. the markup actually contains a script — without one, running a browser
 *      cannot produce text that raw HTML did not already have.
 *
 * Condition 3 is what keeps this from firing on a small-but-complete static
 * page (the `og:description`-only producer site fetch-page.ts documents, whose
 * body text is 20 characters): no script, no escalation, no wasted launch.
 */
export function shouldEscalateToRender(html: string, opts: { bytes?: number } = {}): boolean {
  const bytes = opts.bytes ?? Buffer.byteLength(html);
  if (bytes < RENDER_ESCALATION_MIN_BYTES) return false;
  if (!/<script\b/i.test(html)) return false;
  return visibleTextOf(html).length < RENDER_ESCALATION_TEXT_FLOOR;
}

/**
 * Strip the chrome that survives rendering but is not producer content —
 * script/style/noscript bodies and HTML comments — then reduce to visible
 * text. PURE. Reuses visibleTextOf so raw-HTML and rendered-DOM extraction can
 * never drift apart.
 */
export function renderedTextOf(html: string): string {
  return visibleTextOf(html);
}

/**
 * Which render backend `defaultRenderImpl` should use. PURE — reads only
 * whether `RENDER_WORKER_KEY` is configured, no I/O of its own.
 *
 * "worker" wins whenever the key is present: `render-worker/` (a standalone,
 * already-live Fly app — see the deployment note above) is the ONLY backend
 * available in production, since production's Alpine image has no browser
 * and this repo is not adding one. "local" — the original `playwright-core`
 * path — is the fallback for a dev/sandbox environment that has no worker
 * key configured but may happen to have a local Chromium.
 */
export function selectRenderBackend(): "worker" | "local" {
  return process.env.RENDER_WORKER_KEY ? "worker" : "local";
}

/**
 * What a caller's headless escalation did on ONE fetch — the reportable
 * record of a decision that is otherwise invisible.
 *
 * Daniel, live session 2026-08-15. The first version of this diagnostic was
 * emitted only when a render was actually ATTEMPTED, so an absent record
 * collapsed three states with three different remedies:
 *
 *   flag off               -> set GARDSSALG_HEADLESS_FALLBACK_ENABLED
 *   flag on, not eligible  -> nothing to do (or the thresholds are wrong)
 *   attempted, failed      -> read `reason`
 *
 * Distinguishing them cost a deploy and a live probe per round, on exactly
 * the rows that are hardest to reach. So the two decision bits are now part
 * of the record and it is emitted unconditionally: `flag_enabled` is the
 * caller's kill switch, `eligible` is shouldEscalateToRender()'s verdict, and
 * `attempted` is their conjunction. This is the same rule fetch-page.ts's
 * module doc states for failures — never collapse states whose remedies
 * differ — applied to the decision instead of the outcome.
 *
 * `chars_before` is always meaningful (it is why `eligible` came out the way
 * it did); `chars_after`, `ok`, `reason`, `detail` and `elapsed_ms` exist
 * only once `attempted` is true.
 */
export type RenderEscalationDiagnostic = {
  /** The caller's env kill switch, as read on this call. */
  flag_enabled: boolean;
  /** shouldEscalateToRender()'s verdict on the fetched page. */
  eligible: boolean;
  /** flag_enabled && eligible — whether renderPage() was actually called. */
  attempted: boolean;
  /** Which backend renderPage would use — "worker" needs RENDER_WORKER_KEY. */
  backend: "worker" | "local";
  /** Visible-text length of the RAW fetch, always present. */
  chars_before: number;
  /** Present only when `attempted`. */
  ok?: boolean;
  /** Named failure reason from classifyRenderError. Absent on success. */
  reason?: RenderFailureReason | string;
  detail?: string;
  /** Visible-text length AFTER rendering. Present only on a successful render. */
  chars_after?: number;
  elapsed_ms?: number;
};

// ── The renderer ────────────────────────────────────────────────────────────

export type RenderPageOptions = {
  userAgent: string;
  timeoutMs?: number;
  /**
   * Injected for tests. Receives the url and must resolve to the post-script
   * DOM. Passing a stub here keeps the whole test suite browser-free — the
   * `npm test` gate must never require Chromium, since production has none.
   */
  renderImpl?: (url: string, timeoutMs: number, userAgent: string) => Promise<{ html: string; finalUrl: string }>;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
};

/**
 * Load a URL in a headless browser and return the DOM after scripts have run.
 * Never throws, never returns a bare null.
 *
 * The browser is launched and closed around each call. That is deliberately
 * wasteful of startup time (~300 ms) in exchange for bounded memory: a
 * long-lived browser accumulating pages is precisely what would push a 1024 MB
 * machine over.
 */
export async function renderPage(url: string, opts: RenderPageOptions): Promise<RenderPageResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const elapsed = () => now() - started;

  const impl = opts.renderImpl ?? defaultRenderImpl;

  let rendered: { html: string; finalUrl: string };
  try {
    rendered = await impl(url, timeoutMs, opts.userAgent);
  } catch (err) {
    return { ok: false, ...classifyRenderError(err), elapsedMs: elapsed() };
  }

  const text = renderedTextOf(rendered.html);
  if (text.length === 0) {
    return {
      ok: false,
      reason: "render_empty",
      detail: `rendered ${rendered.html.length}B, 0 visible chars`,
      elapsedMs: elapsed(),
    };
  }

  return { ok: true, html: rendered.html, text, finalUrl: rendered.finalUrl, elapsedMs: elapsed() };
}

/**
 * Map a thrown render error to a named reason. PURE.
 *
 * `renderer_unavailable` is separated from every site-side failure on purpose:
 * it means THIS MACHINE cannot render, so a caller must not record anything
 * about the producer — not a strike, not a verification stamp, nothing. Every
 * other reason is a statement about the site (or the attempt).
 *
 * Covers two shapes now: the local `playwright-core` errors this always
 * handled, and `render-client.ts`'s thrown messages for the worker path
 * (`render-worker <status>: <body>`, `RENDER_WORKER_KEY env var not set`,
 * plain `fetch failed`, or an `AbortError` from the client-side timeout).
 * Once `RENDER_WORKER_KEY` is configured, a worker-side failure is a REAL
 * render failure about that page/attempt — it must land in one of the
 * timeout/navigation/unknown buckets below, never `renderer_unavailable`.
 * The one exception is `RENDER_WORKER_KEY env var not set`: only reachable by
 * racing the env var away between `selectRenderBackend()` picking "worker"
 * and `render-client.ts`'s own guard running, which genuinely does mean this
 * attempt had no backend at all — `renderer_unavailable` is the sane bucket
 * for that message specifically, not for any other worker failure.
 */
export function classifyRenderError(err: unknown): { reason: RenderFailureReason; detail: string } {
  const e = err as { name?: string; message?: string; code?: string };
  const probe = `${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? ""}`;
  const detail = String(e?.message ?? e?.name ?? "error").slice(0, 120);

  if (
    /PLAYWRIGHT_UNAVAILABLE|Cannot find module|ERR_MODULE_NOT_FOUND|browserType\.launch|RENDER_WORKER_KEY env var not set/i.test(
      probe,
    )
  ) {
    return { reason: "renderer_unavailable", detail };
  }
  // render-worker 504 = the worker's own navigation-timeout response
  // (render-worker/src/index.ts classifies its page.goto timeout as 504).
  if (/render-worker 504|Timeout|timed out|TimeoutError|AbortError/i.test(probe)) {
    return { reason: "render_timeout", detail };
  }
  // render-worker 502 = the worker's own navigation-failed response (DNS,
  // TLS, refused — everything page.goto threw that wasn't a timeout).
  if (/render-worker 502|net::|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_CERT|navigation/i.test(probe)) {
    return { reason: "render_navigation_failed", detail };
  }
  return { reason: "unknown", detail };
}

/**
 * The real render path. Branches on `selectRenderBackend()`:
 *   - "worker": delegate to the already-live render-worker via
 *     render-client.ts. No browser touches this process.
 *   - "local": the original playwright-core path, unchanged.
 */
async function defaultRenderImpl(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<{ html: string; finalUrl: string }> {
  if (selectRenderBackend() === "worker") {
    // Same `domcontentloaded` preference as the local branch below, and for
    // the identical reason: producer sites routinely hold a socket open
    // (chat widgets, analytics beacons) and never reach networkidle.
    //
    // `user_agent: userAgent` matters: every caller of this module's
    // renderPage() (marketplace.ts, admin-rfb-website-discovery.ts) passes a
    // specific UA precisely so the render looks like the SAME client as
    // that caller's own plain fetch, not a different crawler, to the target
    // site — see marketplace.ts's comment directly above its UA constant.
    // Dropping it here would silently defeat that for every worker-backed
    // render.
    //
    // Deploy caveat, load-bearing: render-worker/ is a SEPARATE Fly app
    // (`lokal-render-worker`), deployed only by a manual
    // `fly deploy --config render-worker/fly.toml --dockerfile
    // render-worker/Dockerfile` — it is NOT auto-deployed by this repo's
    // `git push origin main` → GitHub Actions pipeline (only the main
    // `lokal` app is). So this UA plumbing is real, correct, and forward-
    // compatible today, but the override will not actually take effect in
    // production until someone with Fly credentials manually redeploys
    // render-worker/. Until then, the worker keeps using its own default
    // USER_AGENT constant (render-worker/src/index.ts) — identical to
    // today's behaviour, not a regression, but also not yet the fix.
    const result = await callRenderWorker(url, {
      timeout_ms: timeoutMs,
      wait_for: "domcontentloaded",
      user_agent: userAgent,
    });
    return { html: result.html, finalUrl: result.final_url };
  }
  return defaultLocalRenderImpl(url, timeoutMs, userAgent);
}

/**
 * The local browser path. Imported lazily so that merely loading this
 * module — which the server does — never requires playwright-core to exist.
 * Unchanged by the worker-backend addition above; still the dev/sandbox
 * fallback for an environment with no RENDER_WORKER_KEY configured.
 */
async function defaultLocalRenderImpl(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<{ html: string; finalUrl: string }> {
  let chromium: any;
  try {
    // The specifier is built at runtime, NOT written as a literal, and that is
    // load-bearing rather than stylistic: `await import("playwright-core")`
    // makes TypeScript resolve the module at COMPILE time, so `npx tsc` fails
    // with TS2307 anywhere the package is absent — which is every clean
    // install, including CI and the production build. This module's whole
    // premise is that it ships inert without the dependency; a version that
    // cannot compile without it breaks the build instead. (Caught by CI on
    // slookisen/lokal#573 after a local typecheck passed only because a
    // --no-save install had left the package lying around.)
    const spec = "playwright-core";
    ({ chromium } = await import(spec));
  } catch {
    throw new Error("PLAYWRIGHT_UNAVAILABLE: playwright-core is not installed in this environment");
  }

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

  // Honour the ambient egress proxy. Node's fetch (and therefore fetch-page.ts)
  // picks HTTPS_PROXY up from the environment, but a browser does not — it
  // opens its own sockets. Without this, a sandboxed/corporate environment
  // renders every page as ERR_CONNECTION_RESET while the plain fetcher on the
  // same machine succeeds, which reads as "the site is broken" and would get
  // recorded against the producer. Measured exactly that on 2026-08-13 before
  // this branch existed.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || undefined;

  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(proxyServer ? { proxy: { server: proxyServer, ...(noProxy ? { bypass: noProxy } : {}) } } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ userAgent });
    const page = await context.newPage();
    // `domcontentloaded` then a short settle beats `networkidle`: producer
    // sites routinely hold a socket open (chat widgets, analytics beacons) and
    // never reach networkidle, which would burn the whole timeout on a page
    // that finished painting in a second.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1_500);
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } finally {
    await browser.close().catch(() => {});
  }
}
