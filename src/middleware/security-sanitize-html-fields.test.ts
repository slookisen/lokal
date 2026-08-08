/**
 * security-sanitize-html-fields.test.ts — tests for the sanitizeInput
 * middleware's HTML-bearing-field allowlist and the two regex corrections,
 * added for dev-request
 * 2026-08-08-crm-html-sanitizer-oedelegger-utgaaende-epost.
 *
 * Background: `app.use(sanitizeInput)` (src/index.ts) runs on EVERY JSON
 * request body and used to strip HTML tags from every string it found. The
 * CRM compose route takes `bodyHtml` — an operator-authored email body —
 * in the request body, so a real outgoing producer email arrived in an inbox
 * on 2026-08-08 with its whole <style> rule-set rendered as visible body
 * text (tags gone, their text content kept) and its signature lines glued
 * together where the <br> elements had been.
 *
 * Covers:
 *   (a) allowlist: `bodyHtml` on /admin/crm/compose survives BYTE-IDENTICAL,
 *       while every sibling field on the same request is still sanitized
 *   (b) the allowlist is path-scoped — the same field name on a non-listed
 *       path is still stripped (a request can never opt itself out)
 *   (c) XSS defence intact: <script>, javascript: URIs and real inline event
 *       handlers are still removed from non-exempt fields, including nested
 *       objects/arrays
 *   (d) the /\bon\w+\s*=/ correction: "sesong=" / "stasjon=" survive (the
 *       old unanchored /on\w+\s*=/ ate them), while " onerror=" and
 *       "<a onclick=" are still stripped
 *   (e) the numeric/hex entity strippers are gone: "&#39;" and "&#x27;"
 *       survive in ordinary text
 *   (f) arrays/nested structures and non-string values are untouched in kind
 *
 * Style mirrors the sibling middleware suites (consumer-identity-*.test.ts):
 * plain function export returning a TestSummary, no framework.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type FakeReq = { body: any; originalUrl?: string; url?: string };

/** Run the real middleware against a fake req and return the mutated body. */
function runSanitize(
  sanitizeInput: (req: any, res: any, next: () => void) => void,
  req: FakeReq,
): any {
  let called = false;
  sanitizeInput(req as any, {} as any, () => {
    called = true;
  });
  if (!called) throw new Error("sanitizeInput did not call next()");
  return req.body;
}

export function runSecuritySanitizeHtmlFieldsTests(
  opts: { log?: boolean } = {},
): TestSummary {
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

  try {
    const { sanitizeInput } = require("./security") as typeof import("./security");

    // The exact shape that broke in production: a full HTML document with a
    // <style> block and <br>-separated signature lines.
    const REAL_HTML = [
      "<!DOCTYPE html>",
      '<html lang="nb"><head><style>',
      "  body { font-family: sans-serif; line-height: 1.6; }",
      "</style></head><body>",
      "  <p><strong>By Brenneri</strong> har fått en profil.</p>",
      "  <p>Med vennlig hilsen<br>Daniel Fredriksen<br>Opplevagent<br>kontakt@opplevagent.no</p>",
      "</body></html>",
    ].join("\n");

    // ── (a) allowlisted field survives; siblings are still sanitized ──────
    const composed = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/compose",
      body: {
        to: "post@eksempel.no",
        subject: "Emne <script>alert(1)</script>",
        bodyText: "Ren tekst <b>uten</b> markup",
        bodyHtml: REAL_HTML,
        contactName: "Daniel <script>x</script>",
      },
    });
    assertEq(composed.bodyHtml, REAL_HTML, "a1: bodyHtml on /admin/crm/compose survives byte-identical");
    assertTrue(String(composed.bodyHtml).includes("<style>"), "a2: the <style> block is still a tag, not prose");
    assertTrue(String(composed.bodyHtml).includes("<br>"), "a3: <br> elements survive (signature lines stay separate)");
    assertEq(composed.subject, "Emne alert(1)", "a4: subject on the SAME request is still stripped");
    assertEq(composed.bodyText, "Ren tekst uten markup", "a5: bodyText on the same request is still stripped");
    assertEq(composed.contactName, "Daniel x", "a6: contactName on the same request is still stripped");

    // Reply route shares the allowlist (same field contract).
    const replied = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/threads/abc-123/send",
      body: { bodyHtml: "<p>Hei <b>igjen</b></p>", bodyText: "<p>Hei</p>" },
    });
    assertEq(replied.bodyHtml, "<p>Hei <b>igjen</b></p>", "a7: bodyHtml on the CRM reply route survives too");
    assertEq(replied.bodyText, "Hei", "a8: bodyText on the reply route is still stripped");

    // Query strings must not defeat the path match.
    const withQuery = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/compose?debug=1",
      body: { bodyHtml: "<p>x</p>" },
    });
    assertEq(withQuery.bodyHtml, "<p>x</p>", "a9: a query string does not break the path match");

    // ── (b) path-scoped: the same field name elsewhere is NOT exempt ──────
    const elsewhere = runSanitize(sanitizeInput, {
      originalUrl: "/api/opplevelser/admin/bulk-load",
      body: { bodyHtml: "<script>alert(1)</script><p>hei</p>" },
    });
    assertEq(elsewhere.bodyHtml, "alert(1)hei", "b1: bodyHtml on a NON-listed path is still stripped — a request cannot opt itself out");

    const lookalikePath = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/composer-evil",
      body: { bodyHtml: "<b>x</b>" },
    });
    assertEq(lookalikePath.bodyHtml, "x", "b2: a look-alike path (/admin/crm/composer-evil) does NOT inherit the exemption — exact match, not loose prefix");

    const trailingSlash = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/compose/",
      body: { bodyHtml: "<b>x</b>" },
    });
    assertEq(trailingSlash.bodyHtml, "<b>x</b>", "b3: a trailing slash still matches the exact-path entry");

    // ── (c) XSS defence on non-exempt fields, incl. nested/array ──────────
    const nested = runSanitize(sanitizeInput, {
      originalUrl: "/api/whatever",
      body: {
        a: '<img src=x onerror="steal()">',
        b: { c: ["<script>bad()</script>", 'javascript:alert(1)'] },
        n: 42,
        t: true,
        z: null,
      },
    });
    assertTrue(!String(nested.a).includes("<img"), "c1: tag stripped in a plain field");
    assertTrue(!String(nested.a).includes("onerror="), "c2: inline event handler stripped");
    assertEq(nested.b.c[0], "bad()", "c3: nested array element stripped");
    assertEq(nested.b.c[1], "alert(1)", "c4: javascript: URI stripped");
    assertEq(nested.n, 42, "c5: numbers pass through unchanged");
    assertEq(nested.t, true, "c6: booleans pass through unchanged");
    assertEq(nested.z, null, "c7: null passes through unchanged");

    // ── (d) the \bon\w+= correction ──────────────────────────────────────
    const norwegian = runSanitize(sanitizeInput, {
      originalUrl: "/api/whatever",
      body: {
        q: "sesong=sommer",
        r: "stasjon=1",
        s: "person=Daniel",
        evil1: '<a onclick="x()">',
        evil2: 'foo onmouseover =alert(1)',
      },
    });
    assertEq(norwegian.q, "sesong=sommer", "d1: 'sesong=' survives (the old unanchored regex ate it, leaving 'ses')");
    assertEq(norwegian.r, "stasjon=1", "d2: 'stasjon=1' survives");
    assertEq(norwegian.s, "person=Daniel", "d3: 'person=Daniel' survives");
    assertTrue(!String(norwegian.evil1).includes("onclick"), "d4: a real onclick= handler is still stripped");
    assertTrue(!String(norwegian.evil2).includes("onmouseover"), "d5: ' onmouseover =' (word-start, spaced) is still stripped");

    // ── (e) entity strippers are gone ────────────────────────────────────
    const entities = runSanitize(sanitizeInput, {
      originalUrl: "/api/whatever",
      body: { text: "Bryggeri&#39;s &#x27;beste&#x27; øl &#248;l" },
    });
    assertEq(
      entities.text,
      "Bryggeri&#39;s &#x27;beste&#x27; øl &#248;l",
      "e1: numeric/hex HTML entities survive in ordinary text (they corrupted harvested producer text and defended nothing on their own)",
    );

    // ── (f) top-level array bodies still sanitize ────────────────────────
    const arrayBody = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/compose",
      body: ["<script>x</script>", "ren tekst"],
    });
    assertEq(arrayBody, ["x", "ren tekst"], "f1: a top-level ARRAY body is sanitized normally, even on an allowlisted path");

    // ── (g) missing/typed-wrong exempt field is a no-op, never a crash ────
    const noHtml = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/compose",
      body: { subject: "<b>x</b>", bodyHtml: 12345 },
    });
    assertEq(noHtml.subject, "x", "g1: sibling still sanitized when bodyHtml is absent-as-string");
    assertEq(noHtml.bodyHtml, 12345, "g2: a non-string bodyHtml passes through untouched (no crash)");

    const noUrl = runSanitize(sanitizeInput, { body: { subject: "<b>y</b>" } });
    assertEq(noUrl.subject, "y", "g3: a request with neither originalUrl nor url still sanitizes");
  } catch (err: any) {
    failed++;
    failures.push(
      "security-sanitize-html-fields: unexpected error: " + String(err?.stack || err?.message || err),
    );
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/middleware/security-sanitize-html-fields.test.ts`
if (require.main === module) {
  const summary = runSecuritySanitizeHtmlFieldsTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
