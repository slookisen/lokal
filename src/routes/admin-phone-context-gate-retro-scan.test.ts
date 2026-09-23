/**
 * admin-phone-context-gate-retro-scan.test.ts — tests POST
 * /admin/phone-context-gate-retro-scan (dev-request 2026-09-22-telefon-
 * css-js-identifikator-falske-positiver, point 3): the one-time retro-scan
 * of existing agent_knowledge.phone values against the FIXED extractPhones()
 * context-gate rule.
 *
 * Mirrors admin-contact-write-guard-retro-sweep.test.ts's harness
 * conventions (in-memory DB via __setDbForTesting/__initSchemaForTesting,
 * router exercised directly via router.handle) plus globalThis.fetch
 * stubbing for the homepage re-fetch (same convention as
 * marketplace-rfb-contact-judge.test.ts's route-level fetch dispatch).
 *
 * Coverage:
 *   1. scanOnePhoneRow (pure, fetchImpl-injected) — Bjørke Gård repro
 *      (facebookAppId JSON blob) -> would_reject; a genuine phone still on
 *      the page -> ok; no homepage_url -> unverifiable; fetch failure ->
 *      unverifiable (fail-closed, never treated as a rejection).
 *   2. Route dry-run (default): reports would_reject_count, writes NOTHING
 *      — full DB row snapshot unchanged.
 *   3. Route apply (dry_run:false): the would_reject row's phone is blanked
 *      to NULL and verification_status reset to 'pending_verify'; a claimed
 *      row is skipped (skipped_claimed); a curated-locked row is skipped
 *      (skipped_curated); a genuinely-still-valid phone row is untouched.
 *
 * Exported runAdminPhoneContextGateRetroScanTests({log}) -> Promise<TestSummary>;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-phone-context-gate-retro-scan.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import {
  scanOnePhoneRow,
  judgePhoneOnPage,
  applyPhoneContextGateReject,
  PHONE_RETRO_SCAN_DEFAULT_LIMIT,
  PHONE_RETRO_SCAN_HARD_CAP,
  PHONE_RETRO_SCAN_TIME_BUDGET_MS,
} from "./admin-phone-context-gate-retro-scan";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) }, ended: true });
      else resolve({ status: 0, body: undefined, ended: false });
    });
  });
}

function htmlResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    url: "",
    headers: { get: () => null } as unknown as Headers,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
  } as unknown as Response;
}

export async function runAdminPhoneContextGateRetroScanTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // scanOnePhoneRow — pure, fetchImpl-injected unit tests.
  // ═══════════════════════════════════════════════════════════════════
  {
    // Bjørke Gård repro: stored phone is a slice of a facebookAppId JSON
    // blob; the fresh page no longer (never did) actually carry it as a
    // real phone -> would_reject.
    const fetchImplBjorke = (async () =>
      htmlResponse(
        200,
        '<html><body><div id="fb-root"></div>' +
        '<div class="fb-config-fallback">{"facebookAppId":"314192535267336"}</div>' +
        "<p>Velkommen til Bjørke Gård!</p></body></html>",
      )) as unknown as typeof fetch;
    const bjorkeVerdict = await scanOnePhoneRow(
      { agent_id: "bjorke", phone: "35267336", website: "https://bjorkegard.no", url: null },
      fetchImplBjorke,
    );
    assertEq(bjorkeVerdict.verdict, "would_reject", "scan-01 (Bjørke Gård repro): a stored phone that's a facebookAppId-blob slice -> would_reject");

    // A genuine phone still actually present on the (freshly re-fetched)
    // page -> ok, not flagged.
    const fetchImplReal = (async () =>
      htmlResponse(200, "<html><body><p>Ring oss på 91234567 for bestilling.</p></body></html>")) as unknown as typeof fetch;
    const realVerdict = await scanOnePhoneRow(
      { agent_id: "real-gard", phone: "91234567", website: "https://real-gard.no", url: null },
      fetchImplReal,
    );
    assertEq(realVerdict.verdict, "ok", "scan-02: a genuinely still-present phone -> ok");

    // No homepage_url on file at all -> unverifiable, never a rejection.
    const noUrlVerdict = await scanOnePhoneRow(
      { agent_id: "no-url-gard", phone: "91234567", website: null, url: null },
      (async () => { throw new Error("must not fetch when there is no homepage_url"); }) as unknown as typeof fetch,
    );
    assertEq(noUrlVerdict.verdict, "unverifiable", "scan-03: no homepage_url on file -> unverifiable, not would_reject");

    // Fetch failure -> unverifiable, fail-closed (never treated as evidence
    // the stored phone is bad).
    const fetchFailVerdict = await scanOnePhoneRow(
      { agent_id: "dead-gard", phone: "91234567", website: "https://dead-gard.no", url: null },
      (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    );
    assertEq(fetchFailVerdict.verdict, "unverifiable", "scan-04: homepage fetch failure -> unverifiable, not would_reject (fail-closed)");

    // agents.url fallback when agent_knowledge.website is blank.
    let requestedUrl = "";
    const fetchImplFallback = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return htmlResponse(200, "<html><body><p>Ring 91234567.</p></body></html>");
    }) as unknown as typeof fetch;
    await scanOnePhoneRow(
      { agent_id: "fallback-gard", phone: "91234567", website: null, url: "https://fallback-gard.no" },
      fetchImplFallback,
    );
    assertEq(requestedUrl, "https://fallback-gard.no", "scan-05: falls back to agents.url when agent_knowledge.website is blank");
  }

  // ═══════════════════════════════════════════════════════════════════
  // B1 fix-up: false-positive regression coverage (CHANGES-REQUESTED
  // finding — the OLD oracle, "is the value in extractPhones(rootHtml)?",
  // wrongly flagged every one of these genuinely-valid shapes as
  // would_reject, which would have blanked a real customer's verified
  // phone number under apply mode). Each of these must now land in `ok`
  // (found, cleanly) or `unverifiable` (genuinely not found anywhere
  // reachable) — NEVER `would_reject`.
  // ═══════════════════════════════════════════════════════════════════
  {
    // fp-01: the number lives ONLY in a `tel:` href — extractPhones() can
    // never see it (whole tag, attributes included, is stripped before it
    // scans) — must be `ok`, not `would_reject`.
    const telOnlyHtml =
      '<html><body><a href="tel:+4791234567">Ring oss</a><p>Velkommen til gården!</p></body></html>';
    const telOnlyVerdict = await scanOnePhoneRow(
      { agent_id: "fp-tel", phone: "91234567", website: "https://fp-tel.no", url: null },
      (async () => htmlResponse(200, telOnlyHtml)) as unknown as typeof fetch,
    );
    assertEq(telOnlyVerdict.verdict, "ok", "fp-01: phone reachable ONLY via a tel: link -> ok, never would_reject");

    // fp-02: the number lives ONLY in a JSON-LD `telephone` field —
    // extractPhones() strips ALL <script> block content before scanning,
    // so it can never see this either — must be `ok`.
    const jsonLdOnlyHtml =
      '<html><head><script type="application/ld+json">' +
      '{"@context":"https://schema.org","@type":"LocalBusiness","name":"Fjord Gård",' +
      '"telephone":"+47 91 23 45 67"}' +
      "</script></head><body><p>Velkommen!</p></body></html>";
    const jsonLdOnlyVerdict = await scanOnePhoneRow(
      { agent_id: "fp-jsonld", phone: "91234567", website: "https://fp-jsonld.no", url: null },
      (async () => htmlResponse(200, jsonLdOnlyHtml)) as unknown as typeof fetch,
    );
    assertEq(jsonLdOnlyVerdict.verdict, "ok", "fp-02: phone reachable ONLY via a JSON-LD telephone field -> ok, never would_reject");

    // fp-03: the number lives ONLY in a <meta> contact tag (Open Graph
    // business contact data) — again inside a tag, invisible to
    // extractPhones() — must be `ok`.
    const metaOnlyHtml =
      '<html><head><meta property="business:contact_data:phone_number" content="91234567"></head>' +
      "<body><p>Velkommen til gården!</p></body></html>";
    const metaOnlyVerdict = await scanOnePhoneRow(
      { agent_id: "fp-meta", phone: "91234567", website: "https://fp-meta.no", url: null },
      (async () => htmlResponse(200, metaOnlyHtml)) as unknown as typeof fetch,
    );
    assertEq(metaOnlyVerdict.verdict, "ok", "fp-03: phone reachable ONLY via a <meta> contact tag -> ok, never would_reject");

    // fp-04: visible text, Norwegian grouped format WITH country code and
    // internal spacing ("+47 91 23 45 67") — must be `ok`.
    const grouped47Html = "<html><body><p>Ring oss på +47 91 23 45 67 i dag.</p></body></html>";
    const grouped47Verdict = await scanOnePhoneRow(
      { agent_id: "fp-grouped47", phone: "91234567", website: "https://fp-grouped47.no", url: null },
      (async () => htmlResponse(200, grouped47Html)) as unknown as typeof fetch,
    );
    assertEq(grouped47Verdict.verdict, "ok", "fp-04: visible '+47 91 23 45 67' grouping -> ok, never would_reject");

    // fp-05: visible text, Norwegian mobile 3-2-3 grouping with NO country
    // code ("912 34 567") — must be `ok`.
    const mobile323Html = "<html><body><p>Ta kontakt: 912 34 567.</p></body></html>";
    const mobile323Verdict = await scanOnePhoneRow(
      { agent_id: "fp-mobile323", phone: "91234567", website: "https://fp-mobile323.no", url: null },
      (async () => htmlResponse(200, mobile323Html)) as unknown as typeof fetch,
    );
    assertEq(mobile323Verdict.verdict, "ok", "fp-05: visible '912 34 567' mobile grouping -> ok, never would_reject");

    // fp-06: the number is NOT on the root page at all, only on a
    // same-domain /kontakt subpage the root page links to — must be `ok`
    // (this is exactly the subpage-follow discipline point 2 of this
    // dev-request already built, reused here).
    const fp06Fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://fp-subpage.no/") {
        return htmlResponse(
          200,
          '<html><body><p>Velkommen!</p><nav><a href="/kontakt">Kontakt</a></nav></body></html>',
        );
      }
      if (u === "https://fp-subpage.no/kontakt") {
        return htmlResponse(200, "<html><body><p>Ring oss på 91234567.</p></body></html>");
      }
      throw new Error(`fp-06: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;
    const fp06Verdict = await scanOnePhoneRow(
      { agent_id: "fp-subpage", phone: "91234567", website: "https://fp-subpage.no/", url: null },
      fp06Fetch,
    );
    assertEq(fp06Verdict.verdict, "ok", "fp-06: phone only present on a linked /kontakt subpage -> ok, never would_reject");

    // fp-07: the phone genuinely is NOT present anywhere reachable (root +
    // subpages) — this must be `unverifiable`, NEVER `would_reject`.
    // Absence is not evidence the new rule rejects it.
    const fp07Fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://fp-absent.no/") {
        return htmlResponse(200, "<html><body><p>Ingen telefonnummer her.</p></body></html>");
      }
      throw new Error(`fp-07: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;
    const fp07Verdict = await scanOnePhoneRow(
      { agent_id: "fp-absent", phone: "91234567", website: "https://fp-absent.no/", url: null },
      fp07Fetch,
    );
    assertEq(fp07Verdict.verdict, "unverifiable", "fp-07: phone genuinely absent everywhere reachable -> unverifiable, NEVER would_reject");
  }

  // ═══════════════════════════════════════════════════════════════════
  // B1 fix-up: positive control — a phone whose ONLY occurrence is
  // genuinely inside a <script> block (not merely a <div>, which the
  // pre-existing Bjørke Gård repro above already covers as the "welded in
  // body text" shape) must STILL be would_reject. This is the shape
  // extractPhones() itself strips before ever scanning.
  // ═══════════════════════════════════════════════════════════════════
  {
    const scriptEmbeddedHtml =
      "<html><head><script>" +
      'var fbConfig = {"facebookAppId":"314192535267336"};' +
      "</script></head><body><p>Velkommen til gården!</p></body></html>";
    const scriptEmbeddedVerdict = await scanOnePhoneRow(
      { agent_id: "fp-script-embedded", phone: "35267336", website: "https://fp-script.no", url: null },
      (async () => htmlResponse(200, scriptEmbeddedHtml)) as unknown as typeof fetch,
    );
    assertEq(
      scriptEmbeddedVerdict.verdict,
      "would_reject",
      "fp-08 (positive control): a phone whose ONLY occurrence is genuinely inside a <script> block -> still would_reject",
    );

    // fp-09 (positive control): welded to a longer digit run in plain
    // body text (no script/style involved at all) -> still would_reject.
    const weldedBodyHtml = "<html><body><p>ID: 3141925352673369 er en referanse.</p></body></html>";
    const weldedBodyVerdict = await scanOnePhoneRow(
      { agent_id: "fp-welded-body", phone: "35267336", website: "https://fp-welded-body.no", url: null },
      (async () => htmlResponse(200, weldedBodyHtml)) as unknown as typeof fetch,
    );
    assertEq(
      weldedBodyVerdict.verdict,
      "would_reject",
      "fp-09 (positive control): welded to a longer digit run in plain visible body text -> still would_reject",
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Round-2 review fix-up, BLOCKING 1: a script/style occurrence is now
  // reject-shape ONLY when it is ALSO welded there (same neighbour-check
  // used for plain-text) — a cleanly-bounded digit run that lives ONLY
  // inside <script>/<style> must land in `unverifiable`, never `ok` and
  // never `would_reject`. Real numbers legitimately live only in script/
  // style on modern sites (client-rendered state blobs, Wix warmupData,
  // booking-widget init calls).
  // ═══════════════════════════════════════════════════════════════════
  {
    // A cleanly-quoted digit run inside a plain (non-JSON-LD) <script>
    // block, not welded to anything longer — e.g. a client-rendered state
    // blob. Must be `unverifiable` — NOT `ok` (it's not confirmable as
    // genuinely-good, extractPhones() would never see it either) and NOT
    // `would_reject` (it's not welded, so it's not the bad CSS-class/JS-
    // identifier shape either).
    const stateBlobHtml =
      '<html><head><script>window.__STATE__={"contact":{"phone":"91234567"}};</script></head>' +
      "<body><p>Gård</p></body></html>";
    const stateBlobVerdict = await scanOnePhoneRow(
      { agent_id: "b1r2-state-blob", phone: "91234567", website: "https://b1r2-state.no", url: null },
      (async () => htmlResponse(200, stateBlobHtml)) as unknown as typeof fetch,
    );
    assertEq(
      stateBlobVerdict.verdict,
      "unverifiable",
      "b1r2-01: cleanly-bounded digit run ONLY inside a window.__STATE__ script blob -> unverifiable (not ok, not would_reject)",
    );

    // Same shape, inside a <style> block (e.g. a CSS content: rule).
    const styleBlobHtml = '<html><head><style>.tel:after{content:"91234567"}</style></head><body><p>Gård</p></body></html>';
    const styleBlobVerdict = await scanOnePhoneRow(
      { agent_id: "b1r2-style-blob", phone: "91234567", website: "https://b1r2-style.no", url: null },
      (async () => htmlResponse(200, styleBlobHtml)) as unknown as typeof fetch,
    );
    assertEq(
      styleBlobVerdict.verdict,
      "unverifiable",
      "b1r2-02: cleanly-bounded digit run ONLY inside a <style> content rule -> unverifiable (not ok, not would_reject)",
    );

    // Positive control (Drivhuset Bageri shape, this time embedded in an
    // actual <script> tag rather than a <div>) — a digit run WELDED to a
    // longer alphanumeric token inside a <script> block must still be
    // would_reject: the fix only exempts CLEANLY-bounded script/style
    // occurrences, never welded ones.
    const drivhusetScriptHtml =
      "<html><head><script>" +
      'var wixInit = {"compId":"StylableButton2545352419"};' +
      "</script></head><body><p>Drivhuset Bageri</p></body></html>";
    const drivhusetScriptVerdict = await scanOnePhoneRow(
      { agent_id: "b1r2-drivhuset-script", phone: "45352419", website: "https://b1r2-drivhuset.no", url: null },
      (async () => htmlResponse(200, drivhusetScriptHtml)) as unknown as typeof fetch,
    );
    assertEq(
      drivhusetScriptVerdict.verdict,
      "would_reject",
      "b1r2-03 (positive control, Drivhuset Bageri repro inside an actual <script> tag): welded to a longer alphanumeric token -> still would_reject",
    );
    // (fp-08 above already covers the equivalent Bjørke Gård facebookAppId
    // shape welded inside a <script> block -> still would_reject.)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Round-2 review fix-up, BLOCKING 1 sub-bugs: phoneFoundViaJsonLd's
  // type= attribute matching and jsonLdNodeHasPhone's value-shape handling.
  // These push MORE genuine numbers into the clean `ok` bucket via the
  // structured-match path, so they never even reach the script/style
  // fallback above.
  // ═══════════════════════════════════════════════════════════════════
  {
    // Whitespace around `type=` — real HTML allows it.
    const spacedTypeHtml =
      '<html><head><script type = "application/ld+json">{"telephone":"91234567"}</script></head>' +
      "<body><p>Gård</p></body></html>";
    const spacedTypeVerdict = await scanOnePhoneRow(
      { agent_id: "b1r2-jsonld-spaced-type", phone: "91234567", website: "https://b1r2-spaced.no", url: null },
      (async () => htmlResponse(200, spacedTypeHtml)) as unknown as typeof fetch,
    );
    assertEq(
      spacedTypeVerdict.verdict,
      "ok",
      'b1r2-04: <script type = "application/ld+json"> (whitespace around =) is still recognised as JSON-LD -> ok',
    );

    // Unquoted `type=` attribute value.
    const unquotedTypeHtml =
      "<html><head><script type=application/ld+json>" +
      '{"telephone":"91234567"}' +
      "</script></head><body><p>Gård</p></body></html>";
    const unquotedTypeVerdict = await scanOnePhoneRow(
      { agent_id: "b1r2-jsonld-unquoted-type", phone: "91234567", website: "https://b1r2-unquoted.no", url: null },
      (async () => htmlResponse(200, unquotedTypeHtml)) as unknown as typeof fetch,
    );
    assertEq(
      unquotedTypeVerdict.verdict,
      "ok",
      "b1r2-05: <script type=application/ld+json> (unquoted attribute value) is still recognised as JSON-LD -> ok",
    );

    // Malformed JSON (trailing comma, common in hand-edited pages) falls
    // back to the phone-key-adjacency text scan instead of falling through
    // to the (now welding-gated) script/style rule.
    const malformedJsonLdHtml =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"LocalBusiness","telephone":"91234567",}' +
      "</script></head><body><p>Gård</p></body></html>";
    const malformedVerdict = await scanOnePhoneRow(
      { agent_id: "b1r2-jsonld-malformed", phone: "91234567", website: "https://b1r2-malformed.no", url: null },
      (async () => htmlResponse(200, malformedJsonLdHtml)) as unknown as typeof fetch,
    );
    assertEq(
      malformedVerdict.verdict,
      "ok",
      "b1r2-06: malformed JSON-LD (trailing comma) falls back to a phone-key-adjacency text scan -> ok, not dropped",
    );

    // A numeric (unquoted) JSON-LD telephone value.
    const numericJsonLdHtml =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"LocalBusiness","telephone":91234567}' +
      "</script></head><body><p>Gård</p></body></html>";
    const numericVerdict = await scanOnePhoneRow(
      { agent_id: "b1r2-jsonld-numeric", phone: "91234567", website: "https://b1r2-numeric.no", url: null },
      (async () => htmlResponse(200, numericJsonLdHtml)) as unknown as typeof fetch,
    );
    assertEq(numericVerdict.verdict, "ok", "b1r2-07: a numeric (unquoted) JSON-LD telephone value -> ok, not dropped");

    // An array JSON-LD telephone value containing the stored digits.
    const arrayJsonLdHtml =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"LocalBusiness","telephone":["91234567","22334455"]}' +
      "</script></head><body><p>Gård</p></body></html>";
    const arrayVerdict = await scanOnePhoneRow(
      { agent_id: "b1r2-jsonld-array", phone: "91234567", website: "https://b1r2-array.no", url: null },
      (async () => htmlResponse(200, arrayJsonLdHtml)) as unknown as typeof fetch,
    );
    assertEq(arrayVerdict.verdict, "ok", "b1r2-08: an array JSON-LD telephone value containing the stored digits -> ok, not dropped");
  }

  // ═══════════════════════════════════════════════════════════════════
  // Round-2 review fix-up, BLOCKING 2: an unreachable/dropped candidate
  // subpage must downgrade an otherwise-reject-shape verdict to
  // `unverifiable` — the real, clean copy of the number might live on
  // exactly the page that couldn't be checked.
  // ═══════════════════════════════════════════════════════════════════
  {
    // Root has a reject-shape (welded) occurrence, and the ONE candidate
    // subpage link on the root fails to fetch -> unverifiable, NOT
    // would_reject.
    const rootWeldedOneLinkHtml =
      '<html><body><div class="fb-config-fallback">{"facebookAppId":"314192535267336"}</div>' +
      '<nav><a href="/kontakt">Kontakt</a></nav></body></html>';
    const b2r2FetchFail = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://b2r2-skip.no/") return htmlResponse(200, rootWeldedOneLinkHtml);
      if (u === "https://b2r2-skip.no/kontakt") throw new TypeError("fetch failed");
      throw new Error(`b2r2-skip: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;
    const b2r2SkipVerdict = await scanOnePhoneRow(
      { agent_id: "b2r2-skip-fetch-fail", phone: "35267336", website: "https://b2r2-skip.no/", url: null },
      b2r2FetchFail,
    );
    assertEq(
      b2r2SkipVerdict.verdict,
      "unverifiable",
      "b2r2-01: root reject-shape occurrence + one candidate subpage fetch error -> unverifiable, not would_reject",
    );

    // Root has a reject-shape occurrence and links to 4 candidate subpages
    // (om, om-oss, kontakt, about) — only 3 may be checked (the cap); the
    // untested 4th (/about) is where the clean copy might live -> must be
    // unverifiable, not would_reject, and the 4th must NEVER be fetched
    // (the cap drops it, the loop must not silently over-fetch either).
    const rootWeldedFourLinksHtml =
      '<html><body><div class="fb-config-fallback">{"facebookAppId":"314192535267336"}</div>' +
      "<nav>" +
      '<a href="/om">Om oss</a>' +
      '<a href="/om-oss">Om gården</a>' +
      '<a href="/kontakt">Kontakt</a>' +
      '<a href="/about">About</a>' +
      "</nav></body></html>";
    const b2r2CapFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://b2r2-cap.no/") return htmlResponse(200, rootWeldedFourLinksHtml);
      if (u === "https://b2r2-cap.no/om") return htmlResponse(200, "<html><body><p>Om oss - ingen telefon her.</p></body></html>");
      if (u === "https://b2r2-cap.no/om-oss") return htmlResponse(200, "<html><body><p>Om gården - ingen telefon her.</p></body></html>");
      if (u === "https://b2r2-cap.no/kontakt") return htmlResponse(200, "<html><body><p>Kontakt oss - ingen telefon her.</p></body></html>");
      throw new Error(`b2r2-cap: the 4th candidate (${u}) must never be fetched — the cap should drop it`);
    }) as unknown as typeof fetch;
    const b2r2CapVerdict = await scanOnePhoneRow(
      { agent_id: "b2r2-cap-dropped", phone: "35267336", website: "https://b2r2-cap.no/", url: null },
      b2r2CapFetch,
    );
    assertEq(
      b2r2CapVerdict.verdict,
      "unverifiable",
      "b2r2-02: 4 candidate subpage links found but only 3 checked (cap) -> unverifiable, not would_reject (the cap dropped a real candidate)",
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Route-level: dry-run (default) and apply.
  // ═══════════════════════════════════════════════════════════════════
  {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "phone-context-gate-retro-scan-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, phone, verification_status, curated_fields)
         VALUES (?, ?, ?, 'verified', ?)`,
      );

      // Row A: junk phone (Bjørke Gård shape), unlocked -> should be flagged
      // would_reject and, under apply, written (blanked + status reset).
      insertAgent.run("pcg-junk", "Bjørke Gård", "https://bjorkegard.no", "key-pcg-junk", null);
      insertKnowledge.run("pcg-junk", "https://bjorkegard.no", "35267336", "{}");

      // Row B: genuine phone, still on the page -> ok, never touched.
      insertAgent.run("pcg-real", "Ekte Gård", "https://ekte-gard.no", "key-pcg-real", null);
      insertKnowledge.run("pcg-real", "https://ekte-gard.no", "91234567", "{}");

      // Row C: junk phone, but the AGENT is owner-claimed -> flagged
      // would_reject, but never written (skipped_claimed).
      insertAgent.run("pcg-claimed", "Kravd Gård", "https://kravd-gard.no", "key-pcg-claimed", "2026-01-01T00:00:00.000Z");
      insertKnowledge.run("pcg-claimed", "https://kravd-gard.no", "45352419", "{}");

      // Row D: junk phone, but curated_fields locks "phone" -> flagged
      // would_reject, but never written (skipped_curated).
      insertAgent.run("pcg-curated", "Kuratert Gård", "https://kuratert-gard.no", "key-pcg-curated", null);
      insertKnowledge.run("pcg-curated", "https://kuratert-gard.no", "45352419", JSON.stringify({ phone: { locked_at: "2026-01-01" } }));

      (globalThis as any).fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("bjorkegard.no")) {
          return htmlResponse(
            200,
            '<div class="fb-config-fallback">{"facebookAppId":"314192535267336"}</div><p>Bjørke Gård</p>',
          );
        }
        if (u.includes("ekte-gard.no")) {
          return htmlResponse(200, "<html><body><p>Ring oss på 91234567.</p></body></html>");
        }
        if (u.includes("kravd-gard.no") || u.includes("kuratert-gard.no")) {
          return htmlResponse(
            200,
            '<div class="wix-warmup-fallback">{"compId":"StylableButton2545352419"}</div><p>Gård</p>',
          );
        }
        return htmlResponse(404, "not found");
      }) as unknown as typeof fetch;

      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
      const routeMod = require("./admin-phone-context-gate-retro-scan");
      const router = routeMod.default;

      // ── Dry-run (default: no body at all) ────────────────────────────
      const beforeSnapshot = db.prepare(`SELECT agent_id, phone, verification_status FROM agent_knowledge ORDER BY agent_id`).all();
      const dryRunResult = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: {},
      });
      assertEq(dryRunResult.status, 200, "route-01: POST /admin/phone-context-gate-retro-scan (dry-run) -> 200");
      assertEq(dryRunResult.body?.dry_run, true, "route-02: dry_run:true by default (no body flag passed)");
      assertEq(dryRunResult.body?.would_reject_count, 3, "route-03: 3 rows flagged would_reject (pcg-junk, pcg-claimed, pcg-curated)");
      assertEq(dryRunResult.body?.written_count, 0, "route-04: dry-run writes NOTHING");
      const afterDryRunSnapshot = db.prepare(`SELECT agent_id, phone, verification_status FROM agent_knowledge ORDER BY agent_id`).all();
      assertEq(afterDryRunSnapshot, beforeSnapshot, "route-05: DB row snapshot is byte-identical before/after a dry-run call");

      const flaggedIds = (dryRunResult.body?.would_reject_rows ?? []).map((r: any) => r.agent_id);
      assertTrue(flaggedIds.includes("pcg-junk"), "route-06: pcg-junk (Bjørke Gård shape) is in would_reject_rows");
      assertTrue(flaggedIds.includes("pcg-claimed"), "route-07: pcg-claimed is in would_reject_rows too (reporting is independent of lock state)");
      assertTrue(flaggedIds.includes("pcg-curated"), "route-08: pcg-curated is in would_reject_rows too");
      assertTrue(!flaggedIds.includes("pcg-real"), "route-09: pcg-real (genuine phone) is NOT in would_reject_rows");

      // ── Apply (dry_run:false, explicit) ──────────────────────────────
      const applyResult = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { dry_run: false },
      });
      assertEq(applyResult.status, 200, "route-10: POST .../phone-context-gate-retro-scan (apply) -> 200");
      assertEq(applyResult.body?.dry_run, false, "route-11: dry_run:false echoed back");
      assertEq(applyResult.body?.written_count, 1, "route-12: exactly 1 row actually written (pcg-junk — the only unlocked would_reject row)");
      assertEq(applyResult.body?.skipped_claimed_count, 1, "route-13: pcg-claimed counted as skipped_claimed");
      assertEq(applyResult.body?.skipped_curated_count, 1, "route-14: pcg-curated counted as skipped_curated");

      const rowJunk = db.prepare(`SELECT phone, verification_status FROM agent_knowledge WHERE agent_id = ?`).get("pcg-junk") as
        { phone: string | null; verification_status: string };
      assertEq(rowJunk.phone, null, "route-15: pcg-junk's phone is blanked to NULL");
      assertEq(rowJunk.verification_status, "pending_verify", "route-16: pcg-junk's verification_status is reset to pending_verify");

      const rowClaimed = db.prepare(`SELECT phone FROM agent_knowledge WHERE agent_id = ?`).get("pcg-claimed") as { phone: string | null };
      assertEq(rowClaimed.phone, "45352419", "route-17: pcg-claimed's phone is UNTOUCHED (claimed_at lock respected)");

      const rowCurated = db.prepare(`SELECT phone FROM agent_knowledge WHERE agent_id = ?`).get("pcg-curated") as { phone: string | null };
      assertEq(rowCurated.phone, "45352419", "route-18: pcg-curated's phone is UNTOUCHED (curated_fields lock respected)");

      const rowReal = db.prepare(`SELECT phone FROM agent_knowledge WHERE agent_id = ?`).get("pcg-real") as { phone: string | null };
      assertEq(rowReal.phone, "91234567", "route-19: pcg-real's phone is untouched throughout (never flagged)");

      const auditRows = db.prepare(`SELECT agent_id, field_name, new_value, changed_by FROM agent_knowledge_audit WHERE agent_id = 'pcg-junk'`).all() as
        Array<{ agent_id: string; field_name: string; new_value: string | null; changed_by: string }>;
      assertEq(auditRows.length, 1, "route-20: exactly one audit row written for pcg-junk");
      assertEq(auditRows[0]?.new_value, null, "route-21: audit row's new_value is NULL (the blank)");
      assertEq(auditRows[0]?.changed_by, "system", "route-22: audit row's changed_by is 'system' (matches CHECK constraint)");
    } catch (err: any) {
      failed++;
      failures.push("admin-phone-context-gate-retro-scan (route section): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // B2 fix-up: limit/cap/wall-clock-budget on the retro-scan route (own
  // in-memory DB + globalThis.fetch stub, scoped to this block so it can
  // never interact with the mutations the section above makes).
  // ═══════════════════════════════════════════════════════════════════
  {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "phone-context-gate-retro-scan-b2-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, NULL)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, phone, verification_status, curated_fields)
         VALUES (?, ?, ?, 'verified', '{}')`,
      );

      // 5 rows, all with a genuinely-still-valid phone (verdict irrelevant
      // to this section — only row SELECTION/budget accounting is under
      // test here).
      for (let i = 1; i <= 5; i++) {
        const id = `pcg-b2-${i}`;
        insertAgent.run(id, `Gård ${i}`, `https://pcg-b2-${i}.no`, `key-${id}`);
        insertKnowledge.run(id, `https://pcg-b2-${i}.no`, "91234567");
      }

      (globalThis as any).fetch = (async () =>
        htmlResponse(200, "<html><body><p>Ring oss på 91234567.</p></body></html>")) as unknown as typeof fetch;

      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
      const routeMod = require("./admin-phone-context-gate-retro-scan");
      const router = routeMod.default;

      // ── limit: an explicit body.limit below the row count is respected —
      //    only that many rows are SELECTED (and therefore scanned) at all.
      const limitedResult = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { limit: 2 },
      });
      assertEq(limitedResult.body?.limit_applied, 2, "b2-01: an explicit limit:2 below the default is respected as limit_applied");
      assertEq(limitedResult.body?.total_rows_selected, 2, "b2-02: only 2 rows are SELECTED from the DB when limit:2 is passed");
      assertEq(limitedResult.body?.total_rows_scanned, 2, "b2-03: exactly the 2 selected rows are actually scanned (no time budget pressure)");

      // ── hard cap: a limit ABOVE PHONE_RETRO_SCAN_HARD_CAP is clamped down
      //    to the hard cap, never honoured as-is.
      const overCapResult = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { limit: PHONE_RETRO_SCAN_HARD_CAP + 1000 },
      });
      assertEq(
        overCapResult.body?.limit_applied,
        PHONE_RETRO_SCAN_HARD_CAP,
        "b2-04: a requested limit above PHONE_RETRO_SCAN_HARD_CAP is clamped to the hard cap",
      );

      // ── default: no limit passed at all -> PHONE_RETRO_SCAN_DEFAULT_LIMIT.
      const defaultLimitResult = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: {},
      });
      assertEq(
        defaultLimitResult.body?.limit_applied,
        PHONE_RETRO_SCAN_DEFAULT_LIMIT,
        "b2-05: no limit passed -> limit_applied defaults to PHONE_RETRO_SCAN_DEFAULT_LIMIT",
      );
      assertEq(defaultLimitResult.body?.total_rows_selected, 5, "b2-06: default limit comfortably covers all 5 fixture rows");

      // ── wall-clock budget: force the injected clock to already be past
      //    PHONE_RETRO_SCAN_TIME_BUDGET_MS on the FIRST loop check, so every
      //    row is skipped for budget — never silently dropped, reported via
      //    time_budget_exceeded + skipped_due_to_time_budget.
      let callCount = 0;
      // NOTE: uses routeMod's OWN export, not a top-level static import —
      // require.cache was deleted and this module dynamically re-required
      // above, so a statically-imported testing-seam setter would bind to a
      // DIFFERENT module instance than the router actually running requests
      // and silently have zero effect.
      routeMod.__setPhoneRetroScanNowForTesting(() => {
        callCount++;
        // First call establishes scanStartedAt; every call after that
        // (including the very first in-loop check) reports as already
        // PAST the budget.
        return callCount === 1 ? 0 : PHONE_RETRO_SCAN_TIME_BUDGET_MS + 1;
      });
      try {
        const budgetResult = await callRoute(router, {
          url: "/",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body: {},
        });
        assertEq(budgetResult.body?.time_budget_exceeded, true, "b2-07: an exhausted wall-clock budget is reported as time_budget_exceeded:true");
        assertEq(budgetResult.body?.total_rows_scanned, 0, "b2-08: zero rows actually scanned once the budget is already exhausted");
        assertEq(
          (budgetResult.body?.skipped_due_to_time_budget ?? []).length,
          5,
          "b2-09: every selected row is accounted for in skipped_due_to_time_budget, not silently dropped",
        );
        assertEq(
          budgetResult.body?.total_rows_selected,
          5,
          "b2-10: total_rows_selected still reports what the SQL selected, independent of the budget outcome",
        );
      } finally {
        routeMod.__setPhoneRetroScanNowForTesting(null);
      }
    } catch (err: any) {
      failed++;
      failures.push("admin-phone-context-gate-retro-scan (B2 limit/cap/budget section): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Round-2 review fix-up, BLOCKING 3: cursor-based pagination. Two
  // sequential calls, each with a limit smaller than the total matching
  // row count, the second passing the first call's next_cursor as
  // after_agent_id — together they must cover every matching row exactly
  // once, with no overlap and nothing left unreached.
  // ═══════════════════════════════════════════════════════════════════
  {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "phone-context-gate-retro-scan-b3-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, NULL)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, phone, verification_status, curated_fields)
         VALUES (?, ?, ?, 'verified', '{}')`,
      );

      // 5 rows; ids sort predictably ascending both lexically and
      // numerically, matching the route's ORDER BY k.agent_id.
      const allIds = ["pcg-b3-1", "pcg-b3-2", "pcg-b3-3", "pcg-b3-4", "pcg-b3-5"];
      for (const id of allIds) {
        insertAgent.run(id, `Gård ${id}`, `https://${id}.no`, `key-${id}`);
        insertKnowledge.run(id, `https://${id}.no`, "91234567");
      }

      // Every row's phone genuinely still present -> every scanned row is
      // "ok" (verdict shape is irrelevant to this section — only row
      // SELECTION/cursor accounting is under test).
      (globalThis as any).fetch = (async () =>
        htmlResponse(200, "<html><body><p>Ring oss på 91234567.</p></body></html>")) as unknown as typeof fetch;

      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
      const routeMod = require("./admin-phone-context-gate-retro-scan");
      const router = routeMod.default;

      const firstPage = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { limit: 3 },
      });
      assertEq(firstPage.body?.total_rows_selected, 3, "b3-01: first call (limit:3, no cursor) selects exactly the first 3 rows");
      assertEq(firstPage.body?.ok_count, 3, "b3-02: first call scans all 3 selected rows as ok (genuine phone still present)");
      assertEq(firstPage.body?.after_agent_id, null, "b3-03: after_agent_id is null on the first (cursor-less) call");
      assertEq(firstPage.body?.next_cursor, "pcg-b3-3", "b3-04: next_cursor is the last SELECTED row's agent_id (3rd in ascending order)");

      const secondPage = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { limit: 3, after_agent_id: firstPage.body?.next_cursor },
      });
      assertEq(secondPage.body?.total_rows_selected, 2, "b3-05: second call (after_agent_id: pcg-b3-3) selects exactly the remaining 2 rows");
      assertEq(secondPage.body?.ok_count, 2, "b3-06: second call scans both remaining rows as ok");
      assertEq(secondPage.body?.after_agent_id, "pcg-b3-3", "b3-07: after_agent_id is echoed back as what was passed");
      assertEq(secondPage.body?.next_cursor, "pcg-b3-5", "b3-08: next_cursor after the second call is the last (5th) row's agent_id");

      assertEq(
        (firstPage.body?.total_rows_selected ?? 0) + (secondPage.body?.total_rows_selected ?? 0),
        5,
        "b3-09: the two sequential calls together select exactly all 5 fixture rows (no overlap, none left unreached)",
      );

      // A third call past the last cursor selects nothing further and
      // reports a null next_cursor (end of table reached).
      const thirdPage = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { limit: 3, after_agent_id: secondPage.body?.next_cursor },
      });
      assertEq(thirdPage.body?.total_rows_selected, 0, "b3-10: a call past the last cursor selects zero further rows");
      assertEq(thirdPage.body?.next_cursor, null, "b3-11: next_cursor is null once there is nothing left to select");
    } catch (err: any) {
      failed++;
      failures.push("admin-phone-context-gate-retro-scan (B3 cursor section): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Round-4 fix (Fix C, round-3 CHANGES-REQUESTED finding): judgePhoneOnPage
  // must not short-circuit to reject_shape on a welded visible-text
  // occurrence before checking whether script/style ALSO carries a clean
  // (non-welded) copy of the same digits — that combination must resolve
  // to "ambiguous_script_style", never "reject_shape".
  // ═══════════════════════════════════════════════════════════════════
  {
    // The digits are welded into visible body text (before/after chars are
    // both alphanumeric) AND, separately, appear cleanly bounded (quoted)
    // inside a <script> block. Old (buggy) logic returned reject_shape as
    // soon as it saw the welded body occurrence, never even looking at the
    // script block. Fixed logic must check script/style for a clean match
    // FIRST and return ambiguous_script_style.
    const weldedBodyCleanScriptHtml =
      '<html><head><script>var phoneBackup = "91234567";</script></head>' +
      "<body><p>Ref91234567Slutt er gammel referansekode, ikke telefon.</p></body></html>";
    const directJudgement = judgePhoneOnPage(weldedBodyCleanScriptHtml, "91234567");
    assertEq(
      directJudgement,
      "ambiguous_script_style",
      "fixC-01: welded in visible text AND clean in script/style -> ambiguous_script_style, NOT reject_shape (direct judgePhoneOnPage call)",
    );

    // End-to-end through scanOnePhoneRow: an ambiguous_script_style page
    // judgement must never surface as would_reject (it folds into
    // unverifiable, same as "absent" — never confirmable either way).
    const weldedBodyCleanScriptVerdict = await scanOnePhoneRow(
      { agent_id: "fixc-welded-and-clean-script", phone: "91234567", website: "https://fixc-welded-clean-script.no", url: null },
      (async () => htmlResponse(200, weldedBodyCleanScriptHtml)) as unknown as typeof fetch,
    );
    assertEq(
      weldedBodyCleanScriptVerdict.verdict,
      "unverifiable",
      "fixC-02: same page end-to-end via scanOnePhoneRow -> unverifiable (ambiguous_script_style must never surface as would_reject)",
    );

    // Regression control: welded in visible text with NO clean script/style
    // alternative anywhere must still resolve to reject_shape (this is
    // exactly fp-09 above, re-asserted here directly against
    // judgePhoneOnPage to pin the decision-order fix precisely).
    const weldedBodyOnlyHtml = "<html><body><p>ID: 3141925352673369 er en referanse.</p></body></html>";
    assertEq(
      judgePhoneOnPage(weldedBodyOnlyHtml, "35267336"),
      "reject_shape",
      "fixC-03 (regression control): welded in visible text with no script/style alternative at all -> still reject_shape",
    );

    // Regression control: a clean visible-text occurrence still wins
    // outright regardless of what script/style contains (script/style is
    // never even consulted once a clean body match is found).
    const cleanBodyHtml = "<html><head><script>var junk = \"91234567ZZZ\";</script></head><body><p>Ring 91234567 i dag.</p></body></html>";
    assertEq(
      judgePhoneOnPage(cleanBodyHtml, "91234567"),
      "clean",
      "fixC-04 (regression control): a clean visible-text occurrence wins outright even when script/style has a welded copy too",
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Round-4 fix (Fix A, round-3 CHANGES-REQUESTED finding): TOCTOU in the
  // apply-mode write path. applyPhoneContextGateReject's write must be a
  // single atomic compare-and-set bound to the EXACT phone value the
  // verdict was computed against — a real phone number written concurrently
  // between the verdict's read and the write must survive untouched, and
  // the call must report { ok: false, reason: "stale_value" } without
  // writing an audit row.
  // ═══════════════════════════════════════════════════════════════════
  {
    const prevDb = initMod.getDb();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, NULL)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, phone, verification_status, curated_fields)
         VALUES (?, ?, ?, 'verified', '{}')`,
      );

      // ── fixA-direct: a stale expectedPhone (simulating a verdict computed
      //    against an old value that has SINCE been overwritten by a real
      //    number) must be rejected atomically, the real number must
      //    survive, and no audit row is written. ──
      insertAgent.run("fixa-direct", "Direkte Gård", "https://fixa-direct.no", "key-fixa-direct");
      insertKnowledge.run("fixa-direct", "https://fixa-direct.no", "91234567");
      // The verdict was computed against "35267336" (the junk value this
      // row USED to have) but the DB row now genuinely holds "91234567" (a
      // real number written concurrently, after the verdict but before this
      // write) — expectedPhone deliberately does not match current state.
      const staleResult = applyPhoneContextGateReject(db, "fixa-direct", "35267336");
      assertEq(staleResult, { ok: false, reason: "stale_value" }, "fixA-01: a stale expectedPhone -> { ok: false, reason: \"stale_value\" }");
      const fixaDirectRow = db.prepare(`SELECT phone, verification_status FROM agent_knowledge WHERE agent_id = ?`).get("fixa-direct") as
        { phone: string | null; verification_status: string };
      assertEq(fixaDirectRow.phone, "91234567", "fixA-02: the REAL concurrently-written phone survives untouched");
      assertEq(fixaDirectRow.verification_status, "verified", "fixA-03: verification_status is untouched (no reset happened)");
      const fixaDirectAudit = db.prepare(`SELECT * FROM agent_knowledge_audit WHERE agent_id = ?`).all("fixa-direct");
      assertEq(fixaDirectAudit.length, 0, "fixA-04: no audit row is written for a stale-value rejection");

      // ── fixA-match: the happy path still works when expectedPhone DOES
      //    match the current value -> written, blanked, audited. ──
      insertAgent.run("fixa-match", "Match Gård", "https://fixa-match.no", "key-fixa-match");
      insertKnowledge.run("fixa-match", "https://fixa-match.no", "35267336");
      const matchResult = applyPhoneContextGateReject(db, "fixa-match", "35267336");
      assertEq(matchResult, { ok: true }, "fixA-05: expectedPhone matching the current value -> { ok: true }");
      const fixaMatchRow = db.prepare(`SELECT phone, verification_status FROM agent_knowledge WHERE agent_id = ?`).get("fixa-match") as
        { phone: string | null; verification_status: string };
      assertEq(fixaMatchRow.phone, null, "fixA-06: matching expectedPhone -> phone is blanked to NULL");
      assertEq(fixaMatchRow.verification_status, "pending_verify", "fixA-07: matching expectedPhone -> verification_status reset to pending_verify");
      const fixaMatchAudit = db.prepare(`SELECT new_value FROM agent_knowledge_audit WHERE agent_id = ?`).all("fixa-match") as Array<{ new_value: string | null }>;
      assertEq(fixaMatchAudit.length, 1, "fixA-08: exactly one audit row written on a successful compare-and-set");
      assertEq(fixaMatchAudit[0]?.new_value, null, "fixA-09: audit row's new_value is NULL");
    } catch (err: any) {
      failed++;
      failures.push("admin-phone-context-gate-retro-scan (Fix A direct section): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      initMod.__setDbForTesting(prevDb as any);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Round-4 fix (Fix A), end-to-end through the route: a concurrent write
  // of a REAL phone number is injected INSIDE the fetch/verdict window
  // (the fetchImpl call scanOnePhoneRow awaits) so it lands between the
  // route's original batch SELECT and its later apply-mode write for the
  // exact same row. The real number must survive, and the row must be
  // reported as skipped_stale, never counted as written.
  // ═══════════════════════════════════════════════════════════════════
  {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "phone-context-gate-retro-scan-fixa-toctou-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, NULL)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, phone, verification_status, curated_fields)
         VALUES (?, ?, ?, 'verified', '{}')`,
      );

      // Starts out as a Bjørke-Gård-shaped junk phone -> would_reject.
      insertAgent.run("fixa-route-toctou", "TOCTOU Gård", "https://fixa-route-toctou.no", "key-fixa-route-toctou");
      insertKnowledge.run("fixa-route-toctou", "https://fixa-route-toctou.no", "35267336");

      const concurrentWrite = db.prepare(`UPDATE agent_knowledge SET phone = ? WHERE agent_id = ?`);

      (globalThis as any).fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("fixa-route-toctou.no")) {
          // Simulate a REAL phone number being written by a concurrent
          // process (e.g. the verifier) WHILE this row's homepage fetch is
          // in flight — i.e. squarely inside the fetch/verdict window,
          // before applyPhoneContextGateReject's own write ever runs.
          concurrentWrite.run("92345678", "fixa-route-toctou");
          return htmlResponse(
            200,
            '<div class="fb-config-fallback">{"facebookAppId":"314192535267336"}</div><p>TOCTOU Gård</p>',
          );
        }
        return htmlResponse(404, "not found");
      }) as unknown as typeof fetch;

      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
      const routeMod = require("./admin-phone-context-gate-retro-scan");
      const router = routeMod.default;

      const applyResult = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { dry_run: false },
      });
      assertEq(applyResult.status, 200, "fixA-route-01: apply-mode call -> 200");
      assertEq(applyResult.body?.would_reject_count, 1, "fixA-route-02: the row is still flagged would_reject (verdict computed against the ORIGINAL junk value)");
      assertEq(applyResult.body?.written_count, 0, "fixA-route-03: NOTHING is written (the compare-and-set found a stale value)");
      assertEq(applyResult.body?.skipped_stale_count, 1, "fixA-route-04: the row is counted as skipped_stale");

      const flaggedEntry = (applyResult.body?.would_reject_rows ?? []).find((r: any) => r.agent_id === "fixa-route-toctou");
      assertEq(flaggedEntry?.write_outcome, "skipped_stale", "fixA-route-05: the row's write_outcome is skipped_stale");

      const finalRow = db.prepare(`SELECT phone, verification_status FROM agent_knowledge WHERE agent_id = ?`).get("fixa-route-toctou") as
        { phone: string | null; verification_status: string };
      assertEq(finalRow.phone, "92345678", "fixA-route-06: the REAL concurrently-written phone number survives untouched end-to-end");
      assertEq(finalRow.verification_status, "verified", "fixA-route-07: verification_status is untouched (no reset happened — nothing was written)");

      const auditRows = db.prepare(`SELECT * FROM agent_knowledge_audit WHERE agent_id = ?`).all("fixa-route-toctou");
      assertEq(auditRows.length, 0, "fixA-route-08: no audit row is written for the stale-value skip");
      assertEq(applyResult.body?.errors?.length ?? 0, 0, "fixA-route-09: a stale-value skip is NOT reported as an error");
    } catch (err: any) {
      failed++;
      failures.push("admin-phone-context-gate-retro-scan (Fix A route TOCTOU section): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Round-4 fix (Fix B, round-3 CHANGES-REQUESTED finding): cursor
  // semantics. next_cursor must be the agent_id of the last row this call
  // actually EXAMINED (scanned), never the last row merely selected — a row
  // dropped purely because the time budget ran out must be revisited on the
  // next call, never silently skipped past. A full cursor-paginated
  // traversal, where the time budget forces an early stop mid-batch, must
  // visit every matching row exactly once across the full traversal.
  // ═══════════════════════════════════════════════════════════════════
  {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "phone-context-gate-retro-scan-fixb-cursor-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, NULL)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, phone, verification_status, curated_fields)
         VALUES (?, ?, ?, 'verified', '{}')`,
      );

      // 5 rows, ids sort predictably ascending, all with a genuinely-still-
      // valid phone (verdict shape is irrelevant here — only which rows get
      // EXAMINED, and how the cursor advances, is under test).
      const allIds = ["fixb-1", "fixb-2", "fixb-3", "fixb-4", "fixb-5"];
      for (const id of allIds) {
        insertAgent.run(id, `Gård ${id}`, `https://${id}.no`, `key-${id}`);
        insertKnowledge.run(id, `https://${id}.no`, "91234567");
      }

      (globalThis as any).fetch = (async () =>
        htmlResponse(200, "<html><body><p>Ring oss på 91234567.</p></body></html>")) as unknown as typeof fetch;

      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
      const routeMod = require("./admin-phone-context-gate-retro-scan");
      const router = routeMod.default;

      // First call: SELECT returns all 5 rows (well within the limit), but
      // the injected clock forces the time budget to be exhausted AFTER the
      // 2nd row's examination — rows 3-5 are selected but never examined,
      // and must therefore be reported by next_cursor as still pending.
      let nowCallCount = 0;
      routeMod.__setPhoneRetroScanNowForTesting(() => {
        nowCallCount++;
        // Call 1 establishes scanStartedAt (= 0). Calls 2 and 3 are the
        // budget checks for row 1 and row 2 (still within budget). Call 4
        // (the budget check for row 3) and every call after report as past
        // the budget, cutting the batch short mid-scan.
        if (nowCallCount <= 3) return 0;
        return PHONE_RETRO_SCAN_TIME_BUDGET_MS + 1;
      });

      let firstCall: any;
      try {
        firstCall = await callRoute(router, {
          url: "/",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body: { limit: 5 },
        });
      } finally {
        routeMod.__setPhoneRetroScanNowForTesting(null);
      }

      assertEq(firstCall.body?.total_rows_selected, 5, "fixB-01: first call selects all 5 rows (well within the limit)");
      assertEq(firstCall.body?.total_rows_scanned, 2, "fixB-02: only 2 rows are actually examined before the budget cuts the batch short");
      assertEq(firstCall.body?.time_budget_exceeded, true, "fixB-03: time_budget_exceeded is reported true");
      assertEq(
        (firstCall.body?.skipped_due_to_time_budget ?? []).sort(),
        ["fixb-3", "fixb-4", "fixb-5"],
        "fixB-04: rows 3-5 are reported as skipped_due_to_time_budget",
      );
      assertEq(
        firstCall.body?.next_cursor,
        "fixb-2",
        "fixB-05: next_cursor is the last EXAMINED row (fixb-2), NOT the last SELECTED row (fixb-5) — the core cursor-semantics fix",
      );
      assertEq(firstCall.body?.scan_fully_complete, false, "fixB-06: scan_fully_complete is false (the batch was cut short by the time budget)");

      // Second call, feeding next_cursor back in as after_agent_id (no
      // budget pressure this time) — must pick up EXACTLY the rows the
      // first call never got to (3, 4, 5), none skipped, none repeated.
      const secondCall = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { limit: 5, after_agent_id: firstCall.body?.next_cursor },
      });
      assertEq(secondCall.body?.total_rows_selected, 3, "fixB-07: second call selects exactly the 3 rows the first call never examined");
      assertEq(secondCall.body?.total_rows_scanned, 3, "fixB-08: all 3 are examined this time (no budget pressure)");
      assertEq(
        (secondCall.body?.ok_count ?? 0),
        3,
        "fixB-09: all 3 previously-skipped rows are now actually scanned as ok (genuine phone still present)",
      );
      assertEq(secondCall.body?.next_cursor, "fixb-5", "fixB-10: next_cursor after the second call is the last row's agent_id (fixb-5)");
      assertEq(secondCall.body?.scan_fully_complete, true, "fixB-11: scan_fully_complete is true once every selected row was examined and the table is exhausted");

      // Union across both calls covers every row exactly once — no row
      // silently skipped because it was cut by the budget and then the
      // cursor moved past it.
      const examinedInFirstCall = 2; // fixb-1, fixb-2 (rows_scanned)
      const examinedInSecondCall = secondCall.body?.total_rows_scanned ?? 0;
      assertEq(
        examinedInFirstCall + examinedInSecondCall,
        5,
        "fixB-12: every one of the 5 fixture rows is examined exactly once across the full cursor-paginated traversal",
      );

      // A third call past the final cursor selects nothing further and
      // reports completion.
      const thirdCall = await callRoute(router, {
        url: "/",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { limit: 5, after_agent_id: secondCall.body?.next_cursor },
      });
      assertEq(thirdCall.body?.total_rows_selected, 0, "fixB-13: a call past the final cursor selects zero further rows");
      assertEq(thirdCall.body?.next_cursor, null, "fixB-14: next_cursor is null once there is nothing left to select");
      assertEq(thirdCall.body?.scan_fully_complete, true, "fixB-15: scan_fully_complete stays true (end of table, nothing pending)");
    } catch (err: any) {
      failed++;
      failures.push("admin-phone-context-gate-retro-scan (Fix B cursor-vs-budget section): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      delete require.cache[require.resolve("./admin-phone-context-gate-retro-scan")];
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminPhoneContextGateRetroScanTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
