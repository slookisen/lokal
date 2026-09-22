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
          '<html><body><p>Velkommen.</p><a href="/om-oss">Om oss</a><a href="/kontakt">Kontakt</a></body></html>',
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
