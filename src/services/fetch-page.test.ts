/**
 * fetch-page.test.ts — unit tests for the shared, CLASSIFIED page fetcher
 * (services/fetch-page.ts).
 *
 * Dev-request 2026-07-27-fetch-infrastruktur-diagnose (P0-1). Every case here
 * is anchored to a real observation from the 2026-07-26 measured probe over
 * the producer domains the enrichment run reports had been calling
 * "fetch_failed", so a future change to the classifier is a deliberate,
 * reviewed decision rather than a silent regression.
 *
 * The invariant these tests exist to protect: a failure must NEVER come back
 * as an unclassified null, and a TRANSIENT failure must never be reported in
 * a way that would let a caller count a 30-day parking strike against a live
 * producer.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/fetch-page.test.ts
 *   2. Wired into the gate: tests/test.ts imports runFetchPageTests() and
 *      folds its pass/fail counts into the `npm test` summary.
 */

import {
  classifyFetchError,
  classifyHttpStatus,
  discoverContentLinks,
  fetchPage,
  isRetryable,
  isUnusableBody,
  parseRetryAfterMs,
  persistenceOf,
  visibleTextOf,
} from "./fetch-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const UA = "Lokal-Test/1.0";

/** Build a mock Response with a real byte body. */
function mockResponse(
  body: string | Uint8Array,
  init: { status?: number; contentType?: string | null; url?: string; headers?: Record<string, string> } = {},
): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers = new Headers(init.headers ?? {});
  if (init.contentType !== null) headers.set("content-type", init.contentType ?? "text/html; charset=utf-8");
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `S${status}`,
    url: init.url ?? "https://example.no/",
    headers,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

/** A body large enough to be unambiguously a real page. */
const BIG_HTML = `<html><body><h1>Gårdsbutikk</h1><p>${"Vi selger kortreist mat fra egen gård. ".repeat(30)}</p></body></html>`;

export async function runFetchPageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // NOTE: this suite never touches globalThis.fetch — every case injects its
  // own `fetchImpl`, so it cannot bleed into (or be polluted by) the other
  // async blocks tests/test.ts runs interleaved.
  try {
    // ── 1. HTTP status classification (each row observed in the probe) ──────
    assertEq(classifyHttpStatus(200), null, "status: 200 is not a failure");
    assertEq(classifyHttpStatus(204), null, "status: 2xx generally is not a failure");
    assertEq(classifyHttpStatus(401), "http_401", "status: 401 (hjortehagen.no login wall)");
    assertEq(classifyHttpStatus(403), "http_403", "status: 403");
    assertEq(classifyHttpStatus(404), "http_404", "status: 404");
    assertEq(classifyHttpStatus(410), "http_410", "status: 410");
    assertEq(classifyHttpStatus(429), "http_429", "status: 429 (lofotenseaweed.com rate limit)");
    assertEq(classifyHttpStatus(503), "http_5xx", "status: 503 (rekoringen.no hosting error)");
    assertEq(classifyHttpStatus(418), "http_4xx", "status: other 4xx");

    // ── 2. Network-error classification ────────────────────────────────────
    assertEq(
      classifyFetchError({ name: "TypeError", cause: { code: "ENOTFOUND" } }),
      "dns_not_found",
      "error: ENOTFOUND (hologardstun.no / norskquinoa.no / handbryggeri.no)",
    );
    assertEq(
      classifyFetchError(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError", code: 23 })),
      "timeout",
      "error: AbortSignal.timeout DOMException (name TimeoutError, code 23 — eventyrmost.no)",
    );
    assertEq(
      classifyFetchError({ name: "TypeError", cause: { code: "ECONNRESET" } }),
      "conn_reset",
      "error: ECONNRESET",
    );
    assertEq(
      classifyFetchError({ name: "TypeError", cause: { code: "ECONNREFUSED" } }),
      "conn_refused",
      "error: ECONNREFUSED",
    );
    assertEq(
      classifyFetchError({ name: "TypeError", cause: { code: "CERT_HAS_EXPIRED" } }),
      "tls_error",
      "error: expired certificate",
    );
    assertEq(classifyFetchError({ name: "TypeError", message: "fetch failed" }), "unknown", "error: unrecognised → unknown (never silently 'ok')");

    // ── 3. Persistence — the rule that stops live producers being parked ────
    assertEq(persistenceOf("dns_not_found"), "permanent", "persistence: dead DNS is permanent (parking justified)");
    assertEq(persistenceOf("http_404"), "permanent", "persistence: 404 is permanent");
    assertEq(persistenceOf("http_5xx"), "transient", "persistence: 5xx is TRANSIENT — hamre-hagen.no/finnskoghonning.no answered 200 next day");
    assertEq(persistenceOf("http_429"), "transient", "persistence: rate limit is TRANSIENT, never a dead-site strike");
    assertEq(persistenceOf("timeout"), "transient", "persistence: timeout is transient");
    assertEq(persistenceOf("tls_error"), "transient", "persistence: expired cert is transient (owner fixes it in days)");
    assertEq(persistenceOf("http_401"), "blocked", "persistence: login wall is blocked, not dead");
    assertEq(persistenceOf("empty_body"), "blocked", "persistence: 200-with-no-content is blocked (vestre-bjolsund.no)");

    assertTrue(
      (["dns_not_found", "http_404", "http_410", "ssrf_blocked"] as const).every((r) => persistenceOf(r) === "permanent"),
      "persistence: exactly the genuinely-dead reasons are permanent",
    );
    assertTrue(
      !(["timeout", "http_5xx", "http_429", "conn_reset"] as const).some((r) => persistenceOf(r) === "permanent"),
      "persistence: NO retryable reason is ever permanent (the mis-parking guard)",
    );

    // ── 4. Retry eligibility ───────────────────────────────────────────────
    assertTrue(isRetryable("timeout") && isRetryable("http_5xx") && isRetryable("conn_reset"), "retry: transient network/server faults retry");
    assertTrue(!isRetryable("dns_not_found") && !isRetryable("http_404"), "retry: dead URLs are never retried (no wasted budget)");
    assertTrue(!isRetryable("http_401") && !isRetryable("empty_body"), "retry: deliberate refusals are never retried");

    // ── 5. Retry-After parsing ─────────────────────────────────────────────
    assertEq(parseRetryAfterMs("60", 0), 60_000, "retry-after: delta-seconds");
    assertEq(parseRetryAfterMs("2", 0), 2_000, "retry-after: short delta-seconds");
    assertEq(parseRetryAfterMs(null, 0), null, "retry-after: absent → null");
    assertEq(parseRetryAfterMs("not-a-date", 0), null, "retry-after: garbage → null");
    assertEq(
      parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("Wed, 21 Oct 2026 07:27:57 GMT")),
      3000,
      "retry-after: HTTP-date form",
    );
    assertEq(parseRetryAfterMs("Wed, 21 Oct 2020 07:28:00 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")), 0, "retry-after: past date clamps to 0");

    // ── 6. Unusable-body detection ─────────────────────────────────────────
    // Fixtures are the VERBATIM bodies the 2026-07-26 probe returned, so these
    // pin the rule against reality rather than against an invented example.
    assertEq(
      isUnusableBody("Database Error: Unable to connect to the database:Could not connect to MySQL", "text/html"),
      "empty_body",
      "body: vestre-bjolsund.no's markup-free MySQL stub (HTTP 200) is empty_body, NOT success",
    );
    assertEq(
      isUnusableBody("upstream connect error or disconnect/reset before headers. retried and the latest reset reason: overflow", "text/plain"),
      "empty_body",
      "body: rekoringen.no's markup-free hosting stub is empty_body",
    );
    assertEq(
      isUnusableBody("<html><head><meta property='og:description' content='Familiedrevet gård på Toten'></head><body><p>Velkomen til garden.</p></body></html>", "text/html"),
      null,
      "body: a SMALL but real page (230B, has markup) is usable — size alone must never disqualify a page",
    );
    assertEq(
      isUnusableBody("<html><body><nav>Hjem Sponsorer Teamet</nav><p>Hauk Racing nyheter og bilder fra sesongen</p></body></html>", "text/html; charset=utf-8"),
      null,
      "body: hamre-hagen.no's 305-visible-char real page is usable (a text-length rule would have killed it)",
    );
    assertEq(
      isUnusableBody("<html><head><meta property='og:description' content='Familiedrevet gård på Toten som dyrker økologiske grønnsaker'></head><body><p>Velkomen til garden.</p></body></html>", "text/html"),
      null,
      "body: a page whose content lives in og:description (20 visible chars) is usable — a visible-text floor would have killed it",
    );
    assertEq(isUnusableBody("<html><body>  </body></html>", "text/html"), null, "body: judging THINNESS is the extractors' job, not the fetcher's — markup means a page exists");
    assertEq(isUnusableBody("%PDF-1.4 ...", "application/pdf"), "not_html", "body: a PDF at the stored homepage URL is not_html");
    assertEq(
      isUnusableBody("<html><body><p>Gårdsbutikk med økologiske grønnsaker rett fra jordet</p></body></html>", null),
      null,
      "body: missing content-type is tolerated (many small NO sites omit it)",
    );
    assertTrue(visibleTextOf("<html><script>var x=1</script><body><p>Hei</p></body></html>") === "Hei", "visibleTextOf: scripts and markup stripped");

    // ── 7. Link discovery — replaces the 100%-miss fixed-path guessing ──────
    {
      const html = `
        <a href="/#kontakt">KONTAKT OG ADRESSE</a>
        <a href="/om-garden">Om gården</a>
        <a href="/vare-produkter">Våre produkter</a>
        <a href="https://facebook.com/x">Facebook</a>
        <a href="/nyheter">Nyheter</a>`;
      const links = discoverContentLinks(html, "https://berg-gaard.no/", 3);
      assertTrue(
        !links.some((l) => l.includes("#")),
        "links: pure in-page anchors are dropped (their content is already in the primary HTML)",
      );
      assertTrue(!links.some((l) => l.includes("facebook")), "links: off-host links are dropped");
      assertTrue(!links.some((l) => l.includes("nyheter")), "links: unrelated pages are dropped");
      assertEq(
        links,
        ["https://berg-gaard.no/om-garden", "https://berg-gaard.no/vare-produkter"],
        "links: real Norwegian paths the fixed /om-oss,/about,/produkter list never covered",
      );
    }
    {
      // Contact outranks about outranks products (contact unblocks outreach).
      const html = `<a href="/produkter">Produkter</a><a href="/om-oss">Om oss</a><a href="/kontakt-oss">Kontakt oss</a>`;
      assertEq(
        discoverContentLinks(html, "https://x.no/", 3),
        ["https://x.no/kontakt-oss", "https://x.no/om-oss", "https://x.no/produkter"],
        "links: ranked contact > about > products",
      );
    }
    assertEq(discoverContentLinks("<a href='/kontakt'>K</a>", "https://x.no/", 0), [], "links: max=0 returns nothing");
    assertEq(discoverContentLinks("", "https://x.no/", 3), [], "links: empty HTML returns nothing");
    assertEq(
      discoverContentLinks("<a href='/kontakt'>K</a><a href='/kontakt'>Kontakt</a>", "https://x.no/", 3),
      ["https://x.no/kontakt"],
      "links: duplicates collapse to one fetch",
    );
    assertEq(discoverContentLinks("<a href='/kontakt'>K</a>", "::::not a url", 3), [], "links: unparseable base returns nothing (no throw)");

    // ── 8. fetchPage end-to-end against a mocked network ───────────────────
    {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return mockResponse(BIG_HTML);
      }) as typeof fetch;
      const r = await fetchPage("https://berg-gaard.no", { userAgent: UA, fetchImpl });
      assertTrue(r.ok, "fetchPage: healthy page returns ok");
      assertTrue(r.ok && r.html.includes("Gårdsbutikk"), "fetchPage: æøå survive the decode path");
      assertEq(calls, 1, "fetchPage: a success costs exactly one request (no gratuitous retry)");
      assertEq(r.attempts, 1, "fetchPage: attempts is reported");
    }
    {
      // windows-1252 body — the charset bug hcrFetchHtml still had.
      const latin1 = Buffer.from(
        `<html><head><meta charset="iso-8859-1"></head><body><p>${"Gårdsysteri med økologisk melk fra Sørlandet. ".repeat(20)}</p></body></html>`,
        "latin1",
      );
      const fetchImpl = (async () => mockResponse(new Uint8Array(latin1), { contentType: "text/html; charset=iso-8859-1" })) as typeof fetch;
      const r = await fetchPage("https://x.no", { userAgent: UA, fetchImpl });
      assertTrue(r.ok && r.html.includes("Gårdsysteri") && r.html.includes("økologisk") && r.html.includes("Sørlandet"), "fetchPage: windows-1252/iso-8859-1 page decodes æøå correctly");
      assertTrue(r.ok && !r.html.includes("�"), "fetchPage: no U+FFFD replacement characters (the resp.text() bug)");
    }
    {
      // Transient 503 that recovers — the hamre-hagen.no / finnskoghonning.no case.
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return calls === 1 ? mockResponse("err", { status: 503, contentType: "text/plain" }) : mockResponse(BIG_HTML);
      }) as typeof fetch;
      const r = await fetchPage("https://hamre-hagen.no", { userAgent: UA, sleep: async () => {}, fetchImpl });
      assertTrue(r.ok, "fetchPage: a transient 503 is retried and RECOVERS (was a permanent 'dead site' before)");
      assertEq(calls, 2, "fetchPage: exactly one retry, not a retry storm");
      assertEq(r.attempts, 2, "fetchPage: attempts reflects the retry");
    }
    {
      // Persistent 503 — retried once, then reported as transient (no strike).
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return mockResponse("err", { status: 503, contentType: "text/plain" });
      }) as typeof fetch;
      const r = await fetchPage("https://rekoringen.no", { userAgent: UA, sleep: async () => {}, fetchImpl });
      assertTrue(!r.ok, "fetchPage: persistent 503 fails");
      assertEq(!r.ok && r.reason, "http_5xx", "fetchPage: reported as http_5xx, not a generic failure");
      assertEq(!r.ok && r.persistence, "transient", "fetchPage: 5xx never justifies a parking strike");
      assertEq(calls, 2, "fetchPage: retried once then gave up");
    }
    {
      // DNS death — must NOT be retried, and IS parking-justified.
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      }) as typeof fetch;
      const r = await fetchPage("https://hologardstun.no", { userAgent: UA, fetchImpl });
      assertEq(!r.ok && r.reason, "dns_not_found", "fetchPage: dead DNS is named");
      assertEq(!r.ok && r.persistence, "permanent", "fetchPage: dead DNS justifies parking");
      assertEq(calls, 1, "fetchPage: dead DNS is not retried (budget preserved)");
    }
    {
      // 429 with a short Retry-After — waits and retries.
      let calls = 0;
      let slept = -1;
      const fetchImpl = (async () => {
        calls++;
        return calls === 1
          ? mockResponse("slow down", { status: 429, contentType: "text/plain", headers: { "retry-after": "2" } })
          : mockResponse(BIG_HTML);
      }) as typeof fetch;
      const r = await fetchPage("https://www.lofotenseaweed.com", {
        userAgent: UA,
        fetchImpl,
        now: () => 0,
        sleep: async (ms) => {
          slept = ms;
        },
      });
      assertTrue(r.ok, "fetchPage: 429 with a short Retry-After is honoured and recovers");
      assertEq(slept, 2000, "fetchPage: waited exactly the Retry-After the server asked for");
    }
    {
      // 429 with a Retry-After longer than we will hold a slot for.
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return mockResponse("slow down", { status: 429, contentType: "text/plain", headers: { "retry-after": "60" } });
      }) as typeof fetch;
      const r = await fetchPage("https://www.lofotenseaweed.com", { userAgent: UA, now: () => 0, sleep: async () => {}, fetchImpl });
      assertEq(!r.ok && r.reason, "http_429", "fetchPage: a 60s Retry-After is reported, not waited out");
      assertEq(!r.ok && r.persistence, "transient", "fetchPage: rate limit stays transient — next run retries it");
      assertEq(calls, 1, "fetchPage: did not burn a second attempt on an over-long Retry-After");
    }
    {
      // 200 with an error stub body.
      const fetchImpl = (async () => mockResponse("Database Error: Unable to connect to the database:Could not connect to MySQL", { status: 200 })) as typeof fetch;
      const r = await fetchPage("https://vestre-bjolsund.no", { userAgent: UA, fetchImpl });
      assertEq(!r.ok && r.reason, "empty_body", "fetchPage: HTTP 200 carrying vestre-bjolsund.no's markup-free error stub is a FAILURE, not success");
      assertEq(!r.ok && r.persistence, "blocked", "fetchPage: empty_body is blocked (stops the forever-recycling loop)");
    }
    {
      // SSRF guard still holds, and reports itself.
      const fetchImpl = (async () => {
        throw new Error("must not be called");
      }) as typeof fetch;
      const r = await fetchPage("http://169.254.169.254/latest/meta-data/", { userAgent: UA, fetchImpl });
      assertEq(!r.ok && r.reason, "ssrf_blocked", "fetchPage: cloud-metadata address is SSRF-blocked before any request");
      assertEq(r.attempts, 0, "fetchPage: SSRF block costs zero requests");
    }
    {
      // Off-origin redirect is surfaced (the dental wrong-entity signal).
      const fetchImpl = (async () => mockResponse(BIG_HTML, { url: "https://tkmidt.no/" })) as typeof fetch;
      const r = await fetchPage("https://www.ullensakertannlegesenter.no", { userAgent: UA, fetchImpl });
      assertTrue(r.ok && r.redirected, "fetchPage: an off-origin redirect is flagged (wrong-entity signal)");
      assertEq(r.ok && r.finalUrl, "https://tkmidt.no/", "fetchPage: the final URL is reported for the wrong-entity guard");
    }
    {
      // Review finding (round 1, blocking #2): the discovery base must be the
      // FINAL url. A homepage that redirects across hosts and emits ABSOLUTE
      // self-links on the new host (stock WordPress via home_url()) would have
      // every link rejected by the same-host test if judged against the
      // pre-redirect host — silently collapsing discovery back to fixed-path
      // guessing aimed at a host that no longer serves the site.
      const html = `<a href="https://www.gard.no/om-oss">Om oss</a><a href="https://www.gard.no/kontakt">Kontakt</a>`;
      assertEq(
        discoverContentLinks(html, "https://gard.no/", 3),
        [],
        "redirect-1: absolute links on the POST-redirect host are (correctly) rejected against the PRE-redirect host — this is why callers must pass finalUrl",
      );
      assertEq(
        discoverContentLinks(html, "https://www.gard.no/", 3),
        ["https://www.gard.no/kontakt", "https://www.gard.no/om-oss"],
        "redirect-2: the same links resolve when the base is the FINAL url",
      );
    }
    {
      // Review finding (round 1, non-blocking #5): an unrecognised content-type
      // must fall through to the markup sniff, not hard-fail. Small Norwegian
      // hosts serve real HTML as application/octet-stream.
      assertEq(
        isUnusableBody("<html><body><p>Gårdsbutikk med økologiske grønnsaker</p></body></html>", "application/octet-stream"),
        null,
        "ct-1: real HTML mislabelled application/octet-stream is usable (was a parking strike)",
      );
      assertEq(
        isUnusableBody("<html><body><p>Gårdsbutikk</p></body></html>", "application/x-httpd-php"),
        null,
        "ct-2: real HTML served as application/x-httpd-php is usable",
      );
      assertEq(isUnusableBody("%PDF-1.4 binary", "application/pdf"), "not_html", "ct-3: a real PDF is still not_html");
      assertEq(isUnusableBody("\x89PNG binary", "image/png"), "not_html", "ct-4: an image is still not_html");
      assertEq(isUnusableBody("{\"a\":1}", "application/json"), "not_html", "ct-5: markup-free JSON is still not_html");
    }
    {
      // Review finding (round 1, minor #10): a 3xx escaping redirect:"follow"
      // must not be mislabelled http_4xx.
      assertEq(classifyHttpStatus(304), "unknown", "3xx-1: an escaped 304 is reported as unknown, not mislabelled http_4xx");
      assertEq(classifyHttpStatus(307), "unknown", "3xx-2: an escaped 307 is reported as unknown");
    }
    {
      // The core contract, stated as a test.
      const fetchImpl = (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EHOSTUNREACH" } });
      }) as typeof fetch;
      const r = await fetchPage("https://x.no", { userAgent: UA, fetchImpl });
      assertTrue(!r.ok && typeof r.reason === "string" && r.reason.length > 0, "CONTRACT: an unrecognised failure still returns a named reason, never a bare null");
      assertTrue(!r.ok && ["permanent", "transient", "blocked"].includes(r.persistence), "CONTRACT: every failure carries a persistence class");
    }
  } catch (err: unknown) {
    failed++;
    failures.push("fetch-page: unexpected error: " + String((err as Error)?.stack || (err as Error)?.message || err));
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/fetch-page.test.ts`
if (require.main === module) {
  console.log("── fetch-page unit tests ──");
  runFetchPageTests({ log: true }).then((r) => {
    console.log(`\nfetch-page: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
