/**
 * lokal-agent-verifier-field-spotcheck.test.ts — dev-request 2026-09-22-
 * telefon-css-js-identifikator-falske-positiver, point 2:
 * computeFieldSpotCheck()/fieldSpotCheckSubpageCandidates() (src/agents/
 * lokal-agent-verifier.ts).
 *
 * Live false-positive this fixes: the weekly field-verification spot-check
 * used to fetch ONLY a field's field_provenance.source_url (the root page)
 * and flag a "mismatch" the instant the field's value wasn't found there.
 * Vollan Gård's `about` text is verbatim present on vollangaard.no/om-oss
 * but never mentioned on the root page, so the root-only check wrongly
 * flagged it. computeFieldSpotCheck now follows up to 3 same-domain
 * /om, /om-oss, /kontakt, /about, /contact links discovered on the root
 * page itself before concluding "mismatch", and stamps `checked_url` to
 * wherever the field was actually found — never unconditionally the root.
 * W40 false-positive fix (sub-05..sub-09, e2e-06): the spot-check now
 * follows up to 5 subpages and also accepts prefixed about/contact pages
 * (/kontakt-oss-2/, /contact-1, /about-1, /om-garden) and terms/privacy pages
 * (/salsvilkar, /personvern, …) via fieldSpotCheckSubpageCandidates'
 * `extended` mode; the function's default (legacy) mode is unchanged.
 *
 * fetchImpl is injected directly into computeFieldSpotCheck's deps (never
 * globalThis.fetch — this file's own stub convention, and the repo's stated
 * preference; see fetch-page.ts's FetchPageOptions.fetchImpl doc comment)
 * so scenarios never bleed into other test files sharing one process.
 *
 * Exported runLokalAgentVerifierFieldSpotCheckTests({log}) -> Promise<TestSummary>;
 * wired into tests/test.ts via runSerial().
 * Standalone: npx tsx src/agents/lokal-agent-verifier-field-spotcheck.test.ts
 */

import {
  computeFieldSpotCheck,
  fieldSpotCheckSubpageCandidates,
  FIELD_SPOT_CHECK_MAX_SUBPAGES,
  FIELD_SPOT_CHECK_MIN_VISIBLE_CHARS,
} from "./lokal-agent-verifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** Minimal fetch Response stub — same shape search-enrich-page-evidence.test.ts
 *  and the sibling lokal-agent-verifier-*.test.ts fetch stubs already use. */
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

export async function runLokalAgentVerifierFieldSpotCheckTests(
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
  // fieldSpotCheckSubpageCandidates — pure link discovery.
  // ═══════════════════════════════════════════════════════════════════
  {
    const html =
      '<html><body>' +
      '<a href="/om-oss">Om oss</a>' +
      '<a href="/kontakt">Kontakt</a>' +
      '<a href="/produkter">Produkter</a>' +
      '<a href="/om-garden">Om gården</a>' +
      '<a href="https://other-site.example/kontakt">Ekstern kontakt</a>' +
      '<a href="#kontakt">In-page anchor</a>' +
      '</body></html>';
    const found = fieldSpotCheckSubpageCandidates(html, "https://vollangaard.no/", 3);
    assertEq(found, ["https://vollangaard.no/om-oss", "https://vollangaard.no/kontakt"],
      "sub-01: discovers same-domain /om-oss and /kontakt links, in document order, excluding /produkter (not one of the 5 accepted shapes), /om-garden (not an exact literal match), the external-domain link, and the pure in-page anchor");

    const foundCapped = fieldSpotCheckSubpageCandidates(
      '<html><body><a href="/om">Om</a><a href="/om-oss">Om oss</a><a href="/kontakt">Kontakt</a><a href="/about">About</a></body></html>',
      "https://gaarden.example/",
      3,
    );
    assertEq(foundCapped.length, 3, "sub-02: maxSubpages caps the result even when more matching links exist on the page");

    const foundNone = fieldSpotCheckSubpageCandidates(
      "<html><body><p>No links at all here.</p></body></html>",
      "https://gaarden.example/",
      3,
    );
    assertEq(foundNone, [], "sub-03: no matching links on the page -> empty array");

    const foundSamePage = fieldSpotCheckSubpageCandidates(
      '<html><body><a href="/">Hjem</a><a href="/kontakt">Kontakt</a></body></html>',
      "https://gaarden.example/",
      3,
    );
    assertEq(foundSamePage, ["https://gaarden.example/kontakt"], "sub-04: a self-link back to the root page is excluded (same page, not a new subpage)");
  }

  // ═══════════════════════════════════════════════════════════════════
  // fieldSpotCheckSubpageCandidates — `extended` mode (W40 false-positive
  // fix: the value lived on /kontakt-oss-2/, /contact-1 and /salsvilkar,
  // none of which the five exact segments matched). Used by
  // computeFieldSpotCheck only; the default stays the legacy exact match.
  // ═══════════════════════════════════════════════════════════════════
  {
    const html =
      '<html><body>' +
      '<a href="/omvisning-servering/">Omvisning</a>' +
      '<a href="/personvern">Personvern</a>' +
      '<a href="/kontakt-oss-2/">Kontakt oss</a>' +
      '<a href="/om-garden">Om gården</a>' +
      '<a href="/omtale">Omtale</a>' +
      '<a href="/produkter">Produkter</a>' +
      '<a href="https://www.vollangaard.no/contact-1">www host</a>' +
      '<a href="https://other-site.example/about-1">Ekstern</a>' +
      '<a href="mailto:post@vollangaard.no">E-post</a>' +
      '<a href="#kontakt">Anchor</a>' +
      '<a href="/about-1">About</a>' +
      '<a href="/salsvilkar">Salsvilkår</a>' +
      '<a href="/kontakt-oss-2/#skjema">Kontakt oss (duplicate)</a>' +
      '</body></html>';
    assertEq(
      fieldSpotCheckSubpageCandidates(html, "https://vollangaard.no/", 5, { extended: true }),
      [
        "https://vollangaard.no/kontakt-oss-2/",
        "https://vollangaard.no/om-garden",
        "https://vollangaard.no/about-1",
        "https://vollangaard.no/personvern",
        "https://vollangaard.no/salsvilkar",
      ],
      "sub-05: extended — prefixed about/contact pages first (document order), then terms/privacy pages (document order, even when linked earlier); " +
        "excludes /omvisning-servering/ and /omtale ('om' + letters is not an about page), /produkter, another host (incl. www.), mailto:, anchors, duplicates",
    );

    assertEq(
      fieldSpotCheckSubpageCandidates(html, "https://vollangaard.no/", 3),
      [],
      "sub-06: default (legacy) mode is unchanged — none of the prefixed/terms shapes match (admin-phone-context-gate-retro-scan.ts relies on this default)",
    );

    const shapes = [
      "/contact-1", "/contactus", "/aboutus", "/about-us.html", "/kontaktinfo", "/kontakt-oss", "/om_oss", "/omoss", "/om.html",
      "/en/contact", "/salgsvilkar", "/kjopsvilkar", "/kj%C3%B8psvilk%C3%A5r", "/personvernerklaering/",
      "/vilkar", "/salgsbetingelser", "/omsorg", "/kontor", "/aboutique",
    ];
    const shapeHtml = "<html><body>" + shapes.map((p) => `<a href="${p}">x</a>`).join("") + "</body></html>";
    assertEq(
      fieldSpotCheckSubpageCandidates(shapeHtml, "https://gaarden.example/", 50, { extended: true }),
      [
        "https://gaarden.example/contact-1",
        "https://gaarden.example/contactus",
        "https://gaarden.example/aboutus",
        "https://gaarden.example/about-us.html",
        "https://gaarden.example/kontaktinfo",
        "https://gaarden.example/kontakt-oss",
        "https://gaarden.example/om_oss",
        "https://gaarden.example/omoss",
        "https://gaarden.example/om.html",
        "https://gaarden.example/en/contact",
        "https://gaarden.example/aboutique",
        "https://gaarden.example/salgsvilkar",
        "https://gaarden.example/kjopsvilkar",
        "https://gaarden.example/kj%C3%B8psvilk%C3%A5r",
        "https://gaarden.example/personvernerklaering/",
      ],
      "sub-07: extended shapes — contact*/about*/kontakt* prefixes, om + separator, omoss*, percent-encoded kjøpsvilkår; " +
        "NOT /vilkar, /salgsbetingelser, /omsorg, /kontor (about* is a plain prefix, so /aboutique is accepted — harmless extra fetch)",
    );

    const sixAbout =
      "<html><body>" +
      ["/salgsvilkar", "/kontakt", "/kontakt-oss", "/om-oss", "/about-us", "/contact-1", "/om-garden"].map((p) => `<a href="${p}">x</a>`).join("") +
      "</body></html>";
    assertEq(
      fieldSpotCheckSubpageCandidates(sixAbout, "https://gaarden.example/", FIELD_SPOT_CHECK_MAX_SUBPAGES, { extended: true }),
      [
        "https://gaarden.example/kontakt",
        "https://gaarden.example/kontakt-oss",
        "https://gaarden.example/om-oss",
        "https://gaarden.example/about-us",
        "https://gaarden.example/contact-1",
      ],
      "sub-08: the cap applies AFTER tier ordering — a terms link earlier in the page never displaces an about/contact page",
    );
    assertEq(FIELD_SPOT_CHECK_MAX_SUBPAGES, 5, "sub-09: the spot-check follows up to 5 subpages (was 3)");
  }

  // e2e-06: computeFieldSpotCheck uses the extended discovery and the
  // 5-subpage default: a value only on the 5th candidate page is found.
  {
    const PHONE = "41634422";
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://femsider.example/") {
        return htmlResponse(
          200,
          '<html><body><p>Velkommen.</p>' +
            ["/personvern", "/om-oss", "/kontakt-oss-2/", "/about-1", "/contact-1", "/salsvilkar"].map((p) => `<a href="${p}">x</a>`).join("") +
            "</body></html>",
        );
      }
      if (u === "https://femsider.example/personvern") return htmlResponse(200, `<html><body><p>Behandlingsansvarleg: Femsider AS, tlf ${PHONE}</p></body></html>`);
      if (u === "https://femsider.example/salsvilkar") throw new Error("e2e-06: the 6th candidate must never be fetched (cap is 5)");
      if (u.startsWith("https://femsider.example/")) return htmlResponse(200, "<html><body><p>Ingenting her.</p></body></html>");
      throw new Error(`e2e-06: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;
    const result = await computeFieldSpotCheck({ field_value: PHONE, root_url: "https://femsider.example/" }, { fetchImpl });
    assertEq(result.status, "match", "e2e-06a: value only on the privacy page (5th candidate, linked FIRST on the page) -> match");
    assertEq(
      result.urls_tried,
      [
        "https://femsider.example/",
        "https://femsider.example/om-oss",
        "https://femsider.example/kontakt-oss-2/",
        "https://femsider.example/about-1",
        "https://femsider.example/contact-1",
        "https://femsider.example/personvern",
      ],
      "e2e-06b: root, then the 4 about/contact pages, then the first terms/privacy page — 5 subpages, /salsvilkar beyond the cap",
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // computeFieldSpotCheck — end-to-end (Vollan Gård repro + regressions).
  // ═══════════════════════════════════════════════════════════════════

  // e2e-01 (Vollan Gård repro, AC2): the about text is NOT on the root page,
  // but the root links to /om-oss, and /om-oss DOES carry the text
  // verbatim -> match, checked_url stamped to /om-oss, NOT the root.
  {
    const ABOUT = "Vollan Gård er en liten familiedrevet gård med sauer og geiter på Innherred.";
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://vollangaard.no/") {
        return htmlResponse(
          200,
          '<html><body><h1>Vollan Gård</h1><p>Velkommen til gården vår!</p>' +
          '<nav><a href="/om-oss">Om oss</a><a href="/kontakt">Kontakt</a></nav></body></html>',
        );
      }
      if (u === "https://vollangaard.no/om-oss") {
        return htmlResponse(200, `<html><body><h1>Om oss</h1><p>${ABOUT}</p></body></html>`);
      }
      throw new Error(`e2e-01: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;

    const result = await computeFieldSpotCheck(
      { field_value: ABOUT, root_url: "https://vollangaard.no/" },
      { fetchImpl },
    );
    assertEq(result.status, "match", "e2e-01a: Vollan Gård's about text is found one level deep on /om-oss -> match, not mismatch");
    assertEq(result.checked_url, "https://vollangaard.no/om-oss", "e2e-01b: checked_url (what provenance should be stamped to) points at /om-oss, NOT the root page");
    assertEq(result.urls_tried, ["https://vollangaard.no/", "https://vollangaard.no/om-oss"], "e2e-01c: root fetched first, then the one subpage that actually carried the match");
  }

  // e2e-02: field found directly on the root page -> match, checked_url is
  // the root, and NO subpage is ever fetched (fetchImpl throws if a second
  // URL is requested) — regression guard for the pre-existing common case.
  {
    const ABOUT = "Testgard selger egne grønnsaker rett fra jordet hver lørdag.";
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      calls++;
      if (calls > 1) throw new Error("e2e-02: a subpage must NEVER be fetched when the root already substantiates the field");
      return htmlResponse(200, `<html><body><p>${ABOUT}</p></body></html>`);
    }) as unknown as typeof fetch;

    const result = await computeFieldSpotCheck(
      { field_value: ABOUT, root_url: "https://testgard.example/" },
      { fetchImpl },
    );
    assertEq(result.status, "match", "e2e-02a: field found directly on the root -> match");
    assertEq(result.checked_url, "https://testgard.example/", "e2e-02b: checked_url is the root when that's where the match actually was");
    assertEq(calls, 1, "e2e-02c: exactly one fetch (the root) — no subpage follow-up when the root already matched");
  }

  // e2e-03: a genuine mismatch — the field isn't substantiated on the root
  // OR any of the discovered subpages -> mismatch (the only outcome that
  // should ever be escalated/paused downstream).
  {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://feilgard.example/") {
        return htmlResponse(
          200,
          `<html><body><p>Velkommen. ${"Vi selger egg og grønnsaker direkte fra gården. ".repeat(30)}</p><a href="/om-oss">Om oss</a><a href="/kontakt">Kontakt</a></body></html>`,
        );
      }
      if (u === "https://feilgard.example/om-oss") {
        return htmlResponse(200, "<html><body><p>Historien om gården vår siden 1950.</p></body></html>");
      }
      if (u === "https://feilgard.example/kontakt") {
        return htmlResponse(200, "<html><body><p>Ring oss på 91234567.</p></body></html>");
      }
      throw new Error(`e2e-03: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;

    const result = await computeFieldSpotCheck(
      { field_value: "Vi driver med alpakkaull og strikking i Numedal.", root_url: "https://feilgard.example/" },
      { fetchImpl },
    );
    assertEq(result.status, "mismatch", "e2e-03a: a value genuinely unsupported anywhere fetched -> mismatch");
    assertEq(result.urls_tried.length, 3, "e2e-03b: root + both discovered subpages were all tried before concluding mismatch");
  }

  // e2e-03c: near-empty static HTML (JS-rendered page) on every fetched page
  // -> unverifiable, NOT mismatch (FUNN field-spot-check-statisk-html-uten-
  // innhold-gir-mismatch). Same shape as e2e-03 but with no substantive text.
  {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://tomgard.example/") {
        return htmlResponse(200, '<html><body><div id="app"></div><a href="/om-oss">Om oss</a></body></html>');
      }
      if (u === "https://tomgard.example/om-oss") return htmlResponse(200, "<html><body><div id=\"app\"></div></body></html>");
      throw new Error(`e2e-03c: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;
    const result = await computeFieldSpotCheck(
      { field_value: "Vi driver med alpakkaull og strikking i Numedal.", root_url: "https://tomgard.example/" },
      { fetchImpl },
    );
    assertEq(result.status, "unverifiable", "e2e-03c: near-empty static HTML everywhere -> unverifiable, not mismatch");
    assertEq(FIELD_SPOT_CHECK_MIN_VISIBLE_CHARS, 1200, "e2e-03d: threshold constant is 1200");
  }

  // e2e-04: the root page cannot be fetched at all -> unverifiable, NEVER
  // mismatch — same fail-closed-toward-no-action posture as the rest of
  // this file's checks (an outage must never look like bad data).
  {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await computeFieldSpotCheck(
      { field_value: "Uansett hvilken verdi", root_url: "https://nede.example/" },
      { fetchImpl },
    );
    assertEq(result.status, "unverifiable", "e2e-04: root fetch failure -> unverifiable, not mismatch");
  }

  // e2e-05: the FIRST discovered subpage 404s, but the SECOND carries the
  // match — a dead subpage link must not abort the follow-up walk.
  {
    const ABOUT = "Bakeriet vårt bruker kun lokale råvarer fra Trøndelag.";
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://bakeri.example/") {
        return htmlResponse(
          200,
          '<html><body><p>Hjemmeside.</p><a href="/om">Om</a><a href="/about">About</a></body></html>',
        );
      }
      if (u === "https://bakeri.example/om") return htmlResponse(404, "Not found");
      if (u === "https://bakeri.example/about") return htmlResponse(200, `<html><body><p>${ABOUT}</p></body></html>`);
      throw new Error(`e2e-05: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;

    const result = await computeFieldSpotCheck(
      { field_value: ABOUT, root_url: "https://bakeri.example/" },
      { fetchImpl },
    );
    assertEq(result.status, "match", "e2e-05a: a dead first subpage doesn't stop the walk — the second subpage still gets checked");
    assertEq(result.checked_url, "https://bakeri.example/about", "e2e-05b: checked_url stamped to the subpage that actually matched");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runLokalAgentVerifierFieldSpotCheckTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
