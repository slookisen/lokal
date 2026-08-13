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
 * This module does NOT add a runtime dependency. `playwright-core` is imported
 * lazily inside a try/catch, so:
 *
 *   - In production (Dockerfile: node:20-alpine, 1024 MB) there is no browser
 *     and no playwright-core. renderPage() returns `renderer_unavailable` and
 *     nothing else changes. Shipping this file is inert there BY DESIGN.
 *   - In an environment that HAS a browser (the Claude Code session container
 *     ships Chromium at $PLAYWRIGHT_BROWSERS_PATH), it renders.
 *
 * That split is intentional and should not be "fixed" by adding playwright to
 * dependencies without a separate, explicit decision. Playwright's own
 * Chromium builds are glibc-only and do not run on Alpine/musl; making
 * production render would mean either leaving Alpine or apk-installing
 * chromium, roughly +400 MB of image, on a shared-cpu-1x machine with 1024 MB
 * of RAM that already sits around 286 MB RSS. Chromium wants 150-300 MB more
 * while a page is open. That is a real risk to a live site serving both
 * rettfrabonden.com and opplevagent.no, and it is Daniel's call to take, not a
 * side effect of landing this file.
 *
 * The escalation decision is PURE and unit-tested; the render itself is the
 * only function here that touches a browser.
 */

import { visibleTextOf } from "./fetch-page";

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
 * other reason is a statement about the site.
 */
export function classifyRenderError(err: unknown): { reason: RenderFailureReason; detail: string } {
  const e = err as { name?: string; message?: string; code?: string };
  const probe = `${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? ""}`;
  const detail = String(e?.message ?? e?.name ?? "error").slice(0, 120);

  if (/PLAYWRIGHT_UNAVAILABLE|Cannot find module|ERR_MODULE_NOT_FOUND|browserType\.launch/i.test(probe)) {
    return { reason: "renderer_unavailable", detail };
  }
  if (/Timeout|timed out|TimeoutError/i.test(probe)) return { reason: "render_timeout", detail };
  if (/net::|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_CERT|navigation/i.test(probe)) {
    return { reason: "render_navigation_failed", detail };
  }
  return { reason: "unknown", detail };
}

/**
 * The real browser path. Imported lazily so that merely loading this module —
 * which the server does — never requires playwright-core to exist.
 */
async function defaultRenderImpl(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<{ html: string; finalUrl: string }> {
  let chromium: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ chromium } = await import("playwright-core"));
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
