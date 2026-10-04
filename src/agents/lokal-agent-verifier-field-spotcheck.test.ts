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
 * W40 review fixes (tier-*, cross-*, budget-*): matched_page_kind + a
 * terms/privacy note in the reason; a WEAK match never ends the walk and a
 * CONFLICT on any fetched page outranks it (exercised with a marker-reading
 * stub `substantiate`, independent of any one field check); the overall
 * FIELD_SPOT_CHECK_BUDGET_MS wall-clock budget (fake clock via deps.now, and
 * a subpage fetch whose timeout is capped to the remaining budget).
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
  FIELD_SPOT_CHECK_BUDGET_MS,
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
    assertEq(result.matched_page_kind, "about_contact", "e2e-05c: matched_page_kind 'about_contact' for a tier-1 subpage");
  }

  // ═══════════════════════════════════════════════════════════════════
  // W40 review fixes: which kind of page matched, weak matches vs
  // conflicts across pages, and the overall time budget.
  // ═══════════════════════════════════════════════════════════════════

  // tier-01: a match on a terms/privacy page is labelled as such (kind +
  // reason), a root match as "root" — same scenario as e2e-06.
  {
    const PHONE = "41634422";
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://tier.example/") {
        return htmlResponse(200, '<html><body><p>Velkommen.</p><a href="/om-oss">Om</a><a href="/personvern">Personvern</a></body></html>');
      }
      if (u === "https://tier.example/personvern") return htmlResponse(200, `<html><body><p>Behandlingsansvarleg: Tier AS, tlf ${PHONE}</p></body></html>`);
      return htmlResponse(200, "<html><body><p>Ingenting her.</p></body></html>");
    }) as unknown as typeof fetch;
    const result = await computeFieldSpotCheck({ field_value: PHONE, root_url: "https://tier.example/" }, { fetchImpl });
    assertEq([result.status, result.matched_page_kind], ["match", "terms_privacy"], "tier-01a: match on /personvern -> matched_page_kind 'terms_privacy'");
    assertTrue(/^matched on a terms\/privacy page — such pages can also list third parties' contact details/.test(result.reason),
      "tier-01b: the reason calls out the terms/privacy page, so the weekly report can tell these matches apart");
    const rootOnly = await computeFieldSpotCheck(
      { field_value: "Velkommen.", root_url: "https://tier.example/" },
      { fetchImpl, substantiate: () => ({ substantiated: true, reason: "stub" }) },
    );
    assertEq([rootOnly.matched_page_kind, rootOnly.reason], ["root", "stub"], "tier-01c: a root match is 'root', reason unchanged");
  }

  // Cross-page weak/conflict: a stub `substantiate` that reads a marker the
  // test puts in each page, so the rule is exercised independently of any
  // one field check. [[STRONG]] = full match, [[WEAK]] = weak match,
  // [[CONFLICT]] = positive contradiction, nothing = plain not-found.
  const markerJudge = (_candidate: string | null | undefined, source: string | null | undefined) => {
    const s = source ?? "";
    if (s.includes("[[STRONG]]")) return { substantiated: true, reason: "strong" };
    if (s.includes("[[WEAK]]")) return { substantiated: true, weak: true, reason: "weak" };
    if (s.includes("[[CONFLICT]]")) return { substantiated: false, conflict: true, reason: "conflict" };
    return { substantiated: false, reason: "not found" };
  };
  const filler = "Vi selger egg og grønnsaker direkte fra gården. ".repeat(30);
  const markerSite = (host: string, root: string, pages: Record<string, string>) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u === `https://${host}/`) {
        return htmlResponse(200, `<html><body><p>${root} ${filler}</p>${Object.keys(pages).map((p) => `<a href="${p}">x</a>`).join("")}</body></html>`);
      }
      const path = u.slice(`https://${host}`.length);
      if (path in pages) return htmlResponse(200, `<html><body><p>${pages[path]}</p></body></html>`);
      throw new Error(`cross: unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  {
    const site = markerSite("x1.example", "[[CONFLICT]]", { "/kontakt": "", "/salsvilkar": "[[WEAK]]" });
    const r = await computeFieldSpotCheck({ field_value: "v", root_url: "https://x1.example/" }, { fetchImpl: site.fetchImpl, substantiate: markerJudge });
    assertEq(r.status, "mismatch", "cross-01: conflict on the root + weak match on a later page -> mismatch");
    assertEq(r.checked_url, "https://x1.example/", "cross-02: a mismatch keeps checked_url at the root");
    assertTrue(/^contradicted on https:\/\/x1\.example\/: conflict — this outranks the weaker match on https:\/\/x1\.example\/salsvilkar \(weak\)$/.test(r.reason),
      "cross-03: reason names the conflicting page and the weak match it outranks");
  }
  {
    const site = markerSite("x2.example", "[[WEAK]]", { "/kontakt": "", "/om-oss": "[[CONFLICT]]" });
    const r = await computeFieldSpotCheck({ field_value: "v", root_url: "https://x2.example/" }, { fetchImpl: site.fetchImpl, substantiate: markerJudge });
    assertEq(r.status, "mismatch", "cross-04: weak match on the root + conflict on a later page -> mismatch");
    assertEq(site.calls, ["https://x2.example/", "https://x2.example/kontakt", "https://x2.example/om-oss"],
      "cross-05: a weak match does not end the walk — every candidate page is still fetched");
  }
  {
    const site = markerSite("x3.example", "[[WEAK]]", { "/kontakt": "", "/om-oss": "" });
    const r = await computeFieldSpotCheck({ field_value: "v", root_url: "https://x3.example/" }, { fetchImpl: site.fetchImpl, substantiate: markerJudge });
    assertEq([r.status, r.checked_url, r.matched_page_kind, r.reason], ["match", "https://x3.example/", "root", "weak"],
      "cross-06: a weak match with no conflict anywhere -> match, stamped to the page of the weak match");
    assertEq(site.calls.length, 3, "cross-07: ... after all candidate pages were checked");
  }
  {
    const site = markerSite("x4.example", "[[CONFLICT]]", { "/kontakt": "[[STRONG]]", "/om-oss": "" });
    const r = await computeFieldSpotCheck({ field_value: "v", root_url: "https://x4.example/" }, { fetchImpl: site.fetchImpl, substantiate: markerJudge });
    assertEq([r.status, r.checked_url], ["match", "https://x4.example/kontakt"],
      "cross-08: a FULL match (the stored value itself on the page) still wins, and still ends the walk at once");
    assertTrue(/^strong \(note: https:\/\/x4\.example\/ contradicts it — conflict\)$/.test(r.reason), "cross-09: ... with the contradiction noted in the reason");
    assertEq(site.calls.length, 2, "cross-10: /om-oss never fetched after the full match");
  }
  {
    const site = markerSite("x5.example", "[[CONFLICT]]", { "/kontakt": "" });
    const r = await computeFieldSpotCheck(
      { field_value: "v", root_url: "https://x5.example/" },
      { fetchImpl: site.fetchImpl, substantiate: markerJudge },
    );
    assertEq(r.status, "mismatch", "cross-11: conflict alone -> mismatch");
  }

  // budget-*: the overall wall-clock budget. A fake clock advances 20 s per
  // fetch; the default budget is 30 s.
  {
    const site = markerSite("slow.example", "", { "/kontakt": "", "/om-oss": "", "/about": "" });
    let clock = 1_000_000;
    const slowFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      clock += 20_000;
      return (site.fetchImpl as any)(url, init);
    }) as unknown as typeof fetch;
    const r = await computeFieldSpotCheck(
      { field_value: "v", root_url: "https://slow.example/" },
      { fetchImpl: slowFetch, substantiate: markerJudge, now: () => clock },
    );
    assertEq(FIELD_SPOT_CHECK_BUDGET_MS, 30_000, "budget-01: default budget is 30 s");
    assertEq(r.status, "unverifiable", "budget-02: budget spent before a verdict -> unverifiable, NOT mismatch");
    assertEq(r.urls_tried, ["https://slow.example/", "https://slow.example/kontakt"],
      "budget-03: root (t=20 s) + one subpage (started with 10 s left); no subpage starts after the budget is spent");
    assertTrue(/^time budget \(30000 ms\) spent after 2 page\(s\); 2 subpage\(s\) not checked before a verdict/.test(r.reason),
      "budget-04: the reason says how many pages were not checked");
  }
  {
    const site = markerSite("slow2.example", "[[WEAK]]", { "/kontakt": "", "/om-oss": "", "/about": "" });
    let clock = 0;
    const slowFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      clock += 20_000;
      return (site.fetchImpl as any)(url, init);
    }) as unknown as typeof fetch;
    const r = await computeFieldSpotCheck(
      { field_value: "v", root_url: "https://slow2.example/" },
      { fetchImpl: slowFetch, substantiate: markerJudge, now: () => clock },
    );
    assertEq(r.status, "match", "budget-05: a weak match already found when the budget runs out -> match");
    assertTrue(/^weak \(time budget \(30000 ms\) spent after 2 page\(s\); 2 subpage\(s\) not checked for a conflicting value\)$/.test(r.reason),
      "budget-06: ... and the reason says the remaining pages were not checked for a conflict");
  }
  {
    const site = markerSite("slow3.example", "[[CONFLICT]]", { "/kontakt": "", "/om-oss": "" });
    let clock = 0;
    const slowFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      clock += 40_000;
      return (site.fetchImpl as any)(url, init);
    }) as unknown as typeof fetch;
    const r = await computeFieldSpotCheck(
      { field_value: "v", root_url: "https://slow3.example/" },
      { fetchImpl: slowFetch, substantiate: markerJudge, now: () => clock },
    );
    assertEq([r.status, r.urls_tried.length], ["mismatch", 1], "budget-07: a conflict on the root is a verdict even when no subpage could be fetched in time");
  }
  {
    // A custom budget, and a subpage fetch whose own timeout is capped to
    // what is left of it: the stub would only answer after 5 s (a ref'd
    // timer, which also keeps the event loop alive — AbortSignal.timeout's
    // own timer is unref'd), so only the capped AbortSignal can end it early.
    const calls: string[] = [];
    let clock = 0;
    const hangingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u === "https://heng.example/") {
        clock += 1_000;
        return htmlResponse(200, `<html><body><p>${filler}</p><a href="/kontakt">Kontakt</a></body></html>`);
      }
      return new Promise((resolve, reject) => {
        const late = setTimeout(() => resolve(htmlResponse(200, "<html><body><p>[[STRONG]]</p></body></html>")), 5_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(late);
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await computeFieldSpotCheck(
      { field_value: "v", root_url: "https://heng.example/", budgetMs: 1_150 },
      { fetchImpl: hangingFetch, substantiate: markerJudge, now: () => clock },
    );
    const elapsed = Date.now() - t0;
    assertTrue(elapsed < 2_000, `budget-08: a hanging subpage fetch is cut off by the remaining budget (150 ms + one retry), not the 10 s default (took ${elapsed} ms)`);
    assertEq(r.status, "mismatch", "budget-09: the hanging subpage simply failed; the walk completed within budget -> ordinary verdict");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runLokalAgentVerifierFieldSpotCheckTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
