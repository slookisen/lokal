/**
 * security-sanitize-fixpoint.test.ts — tests for the sanitizeInput string
 * filter running to a fixpoint, added for dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-L.
 *
 * Background: sanitizeValue() (src/middleware/security.ts) used to run its
 * three strippers — `<[^>]*>`, `\bon\w+\s*=`, `javascript:` — exactly once.
 * Each one deletes text, so a deletion could rebuild a pattern from its two
 * halves: `onjavascript:error=` came out as `onerror=` and
 * `javajavascript:script:` as `javascript:` (reproduced by the 2026-10-17
 * security review's skeptic on a copy of the regex chain). The pass now
 * repeats until the string stops changing, bounded by SANITIZE_MAX_PASSES
 * (still changing on the last pass → the string is dropped, fail-closed).
 * What a pass removes is NOT widened.
 *
 * `mainOnce` below is a frozen copy of the single pass as it stood on main
 * before I-L; it is the "before" side of every parity check.
 *
 * Covers:
 *   (a) the repro cases: main's single pass leaves a working `on…=` or
 *       `javascript:`; the filter now leaves none
 *   (b) every string position (nested objects/arrays) gets the fixpoint; the
 *       HTML-bearing-field exemption (bodyHtml on the CRM routes) is unchanged
 *   (c) the bound: one nesting level below it is stripped normally, at it the
 *       string is dropped, siblings are untouched
 *   (d) seeded fuzz: the result is always stable under one more pass, equals
 *       the unbounded fixpoint of main's pass (or "" past the bound), and
 *       equals main's output whenever main's output was already stable
 *   (e) the linear tag stripper gives exactly `s.replace(/<[^>]*>/g, "")`
 *   (f) corpus: ordinary Norwegian text, 600+ real seed descriptions, the UI
 *       locale strings and real producer web pages are byte-identical to main
 *   (g) cost: text without a removal costs one pass, text with one removal two;
 *       the "<"-run that took ~17 s on main and a 1 MB body that hits the bound
 *       both finish in milliseconds
 *
 * Style mirrors security-sanitize-html-fields.test.ts: plain function export
 * returning a TestSummary, no framework, the real middleware on a fake req.
 */

import * as fs from "fs";
import * as path from "path";

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

/** The single pass exactly as it stood on main before I-L (frozen reference). */
function mainOnce(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/\bon\w+\s*=/gi, "")
    .replace(/javascript:/gi, "");
}

/**
 * Unbounded fixpoint of mainOnce(), with the number of passes it took
 * INCLUDING the final pass that changed nothing — the same count the bounded
 * loop in security.ts compares against SANITIZE_MAX_PASSES.
 */
function referenceFixpoint(s: string): { value: string; passes: number } {
  let current = s;
  for (let passes = 1; ; passes++) {
    const next = mainOnce(current);
    if (next === current) return { value: current, passes };
    current = next;
  }
}

/** A working pattern is left: an event-handler attribute, a javascript: URI or a tag. */
function hasPattern(s: string): boolean {
  return /\bon\w+\s*=/i.test(s) || /javascript:/i.test(s) || /<[^>]*>/.test(s);
}

/** `javascript:` hidden `depth` levels deep; needs depth + 1 removing passes. */
function nestJs(depth: number): string {
  return "java".repeat(depth) + "javascript:" + "script:".repeat(depth);
}

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every string value in a parsed JSON document. */
function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) jsonStrings(v, out);
  return out;
}

const REPO_ROOT = path.join(__dirname, "..", "..");

/** `description: "…"` literals from the historical seed scripts (real producer text). */
function seedDescriptions(): string[] {
  const dir = path.join(REPO_ROOT, "src", "_seeds");
  const out: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of src.matchAll(/description:\s*"((?:[^"\\]|\\.)*)"/g)) {
      try {
        out.push(JSON.parse(`"${m[1]}"`) as string);
      } catch {
        /* a TS-only escape JSON cannot read — not needed for the corpus */
      }
    }
  }
  return out;
}

export function runSecuritySanitizeFixpointTests(
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
    const { sanitizeInput, SANITIZE_MAX_PASSES } = require("./security") as typeof import("./security");
    const sanitize = (s: string): string =>
      runSanitize(sanitizeInput, { originalUrl: "/api/whatever", body: { s } }).s;
    /** Many strings through ONE middleware call (fuzz/corpus speed). */
    const sanitizeAll = (list: string[]): string[] =>
      runSanitize(sanitizeInput, { originalUrl: "/api/whatever", body: { list } }).list;

    // ── (a) the repro cases ──────────────────────────────────────────────
    const REPROS: Array<[label: string, input: string, expected: string]> = [
      ["onjavascript:error= (the reported on…= rebuild)", "onjavascript:error=alert(1)", "alert(1)"],
      ["javajavascript:script: (the reported javascript: rebuild)", "javajavascript:script:alert(1)", "alert(1)"],
      ["attribute-shaped payload", 'x" onjavascript:error="alert(1)', 'x" "alert(1)'],
      ["mixed case", "JaVajavascript:ScRiPt:alert(1)", "alert(1)"],
      ["whitespace before =", "onjavascript:error =alert(1)", "alert(1)"],
      ["three levels deep", "javajavajavascript:script:script:alert(1)", "alert(1)"],
      ["javascript: nested inside on…=", "onjavajavascript:script:error=alert(1)", "alert(1)"],
      ["tag glues javascript: back", "java<b>javascript:</b>script:alert(1)", "alert(1)"],
      ["tag glues on…= back", "on<i>javascript:</i>error=alert(1)", "alert(1)"],
      ["href-shaped text", "href=javajavascript:script:alert(1)", "href=alert(1)"],
    ];
    for (const [label, input, expected] of REPROS) {
      assertTrue(hasPattern(mainOnce(input)), `a: repro on main — ${label}: one pass leaves a pattern (${JSON.stringify(mainOnce(input))})`);
      const out = sanitize(input);
      assertEq(out, expected, `a: ${label}`);
      assertTrue(!hasPattern(out), `a: ${label} — no on…=, javascript: or tag left`);
    }

    // ── (b) every position; the HTML-field exemption is unchanged ────────
    const nested = runSanitize(sanitizeInput, {
      originalUrl: "/api/whatever",
      body: {
        a: [{ b: "onjavascript:error=x" }, ["javajavascript:script:y"]],
        c: { d: { e: "on<i>javascript:</i>error=z" } },
        n: 7,
        t: false,
        z: null,
      },
    });
    assertEq(nested.a[0].b, "x", "b1: object inside an array gets the fixpoint");
    assertEq(nested.a[1][0], "y", "b2: array inside an array gets the fixpoint");
    assertEq(nested.c.d.e, "z", "b3: deeply nested object gets the fixpoint");
    assertEq([nested.n, nested.t, nested.z], [7, false, null], "b4: non-strings pass through unchanged");

    const crmHtml = '<p onclick="x()">Hei</p><a href="javajavascript:script:void(0)">lenke</a>';
    const composed = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/compose",
      body: { bodyHtml: crmHtml, subject: "onjavascript:error=Emne" },
    });
    assertEq(composed.bodyHtml, crmHtml, "b5: bodyHtml on /admin/crm/compose is still exempt (byte-identical)");
    assertEq(composed.subject, "Emne", "b6: a sibling field on the same request gets the fixpoint");
    const replied = runSanitize(sanitizeInput, {
      originalUrl: "/admin/crm/threads/abc-123/send",
      body: { bodyHtml: crmHtml, bodyText: "javajavascript:script:x" },
    });
    assertEq(replied.bodyHtml, crmHtml, "b7: bodyHtml on the CRM reply route is still exempt");
    assertEq(replied.bodyText, "x", "b8: bodyText on the reply route gets the fixpoint");
    const elsewhere = runSanitize(sanitizeInput, {
      originalUrl: "/api/opplevelser/admin/bulk-load",
      body: { bodyHtml: "onjavascript:error=x" },
    });
    assertEq(elsewhere.bodyHtml, "x", "b9: bodyHtml on a non-listed path gets the fixpoint");

    // ── (c) the bound ────────────────────────────────────────────────────
    assertEq(SANITIZE_MAX_PASSES, 10, "c1: the bound is 10 passes (dev-request: «for eksempel 10 runder»)");
    // nestJs(d) needs d + 1 removing passes plus one that confirms.
    const below = nestJs(SANITIZE_MAX_PASSES - 2);
    const at = nestJs(SANITIZE_MAX_PASSES - 1);
    assertEq(referenceFixpoint(below).passes, SANITIZE_MAX_PASSES, "c2: the case below the bound needs exactly SANITIZE_MAX_PASSES passes");
    assertEq(referenceFixpoint(at).passes, SANITIZE_MAX_PASSES + 1, "c3: the case at the bound needs one pass more");
    assertEq(sanitize(`før ${below} etter`), "før  etter", "c4: below the bound the pattern is stripped and the text around it kept");
    assertEq(sanitize(`før ${at} etter`), "", "c5: still changing on the last pass → the string is dropped (fail-closed), not returned with a rebuilt pattern");
    const bounded = runSanitize(sanitizeInput, {
      originalUrl: "/api/whatever",
      body: { evil: `før ${at} etter`, plain: "sesong=sommer", tag: "<b>fet</b>", list: [at, "ok"] },
    });
    assertEq(
      bounded,
      { evil: "", plain: "sesong=sommer", tag: "fet", list: ["", "ok"] },
      "c6: only the over-bound strings are dropped; siblings and array neighbours are sanitized as usual",
    );
    // An on…= around the nest costs one removing pass more than the nest alone.
    const onBelow = `on${nestJs(SANITIZE_MAX_PASSES - 3)}error=x`;
    const onAt = `on${nestJs(SANITIZE_MAX_PASSES - 2)}error=x`;
    assertEq(
      [referenceFixpoint(onBelow).passes, referenceFixpoint(onAt).passes],
      [SANITIZE_MAX_PASSES, SANITIZE_MAX_PASSES + 1],
      "c7: on…= around a nest — one case on each side of the bound",
    );
    assertEq(sanitize(onBelow), "x", "c8: below the bound on…= is stripped and the rest kept");
    assertEq(sanitize(onAt), "", "c9: at the bound the string is dropped");

    // ── (d) seeded fuzz against the unbounded reference ──────────────────
    // The pieces a rebuild is made of appear twice, so rebuilds are common.
    const FRAGMENTS = [
      "on", "on", "On", "ON", "javascript:", "javascript:", "JavaScript:", "java", "java", "JAVA",
      "script:", "script:", "Script:", "error", "error=", "click", "x", "=", " =", " ", "\t", "-", ":",
      "<", ">", "<b>", "</b>", "<a href=", "o", "n", "a", "sesong=", "&#39;", "æ", "1",
    ];
    const rand = rng(20261017);
    const fuzz: string[] = [];
    for (let i = 0; i < 20000; i++) {
      let s = "";
      const parts = 1 + Math.floor(rand() * 14);
      for (let j = 0; j < parts; j++) s += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
      fuzz.push(s);
    }
    const fuzzOut = sanitizeAll(fuzz);
    let unstableOnMain = 0;
    let fuzzBad = 0;
    let firstBad = "";
    for (let i = 0; i < fuzz.length; i++) {
      const input = fuzz[i];
      const out = fuzzOut[i];
      const main = mainOnce(input);
      const ref = referenceFixpoint(input);
      const expected = ref.passes <= SANITIZE_MAX_PASSES ? ref.value : "";
      const mainStable = mainOnce(main) === main;
      if (!mainStable) unstableOnMain++;
      const ok =
        out === expected &&
        mainOnce(out) === out && // stable: one more pass changes nothing
        !hasPattern(out) &&
        (!mainStable || out === main); // nothing changes where main was already stable
      if (!ok) {
        fuzzBad++;
        if (!firstBad) firstBad = `${JSON.stringify(input)} → ${JSON.stringify(out)} (expected ${JSON.stringify(expected)}, main ${JSON.stringify(main)})`;
      }
    }
    assertEq(fuzzBad, 0, `d1: 20000 seeded strings: stable, pattern-free, equal to the reference fixpoint and to main where main was stable${firstBad ? " — first: " + firstBad : ""}`);
    assertTrue(unstableOnMain >= 200, `d2: the fuzz is not vacuous — ${unstableOnMain} inputs rebuild a pattern on main's single pass`);

    // ── (e) the linear tag stripper is the old regex, exactly ────────────
    const TAG_EDGES = [
      "", "<", ">", "<>", "a<b", "a>b<c", "<<>>", "x<y>z<", "<a\nb>c", "> <", "<<<", ">>>", "a<b>c<d", "<b>fet</b> og <i",
    ];
    const tagRand = rng(1017);
    const tagAlphabet = ["<", ">", "a", "b", " ", "\n", "/", "="];
    const tagCases = [...TAG_EDGES];
    for (let i = 0; i < 5000; i++) {
      let s = "";
      const len = Math.floor(tagRand() * 24);
      for (let j = 0; j < len; j++) s += tagAlphabet[Math.floor(tagRand() * tagAlphabet.length)];
      tagCases.push(s);
    }
    const tagOut = sanitizeAll(tagCases);
    let tagBad = "";
    for (let i = 0; i < tagCases.length; i++) {
      // No on…= or javascript: can occur in this alphabet, so the old tag
      // regex alone is the expected result.
      if (tagOut[i] !== tagCases[i].replace(/<[^>]*>/g, "") && !tagBad) {
        tagBad = `${JSON.stringify(tagCases[i])} → ${JSON.stringify(tagOut[i])}`;
      }
    }
    assertEq(tagBad, "", `e1: ${tagCases.length} tag-only strings: the result equals s.replace(/<[^>]*>/g, "")`);

    // ── (f) corpus: byte-identical to main ───────────────────────────────
    const ORDINARY = [
      "sesong=sommer",
      "stasjon=1",
      "person=Daniel",
      "Åpent onsdag–fredag 10–16, lørdag 10–14.",
      "Vi selger honning, egg og ost fra egen gård.",
      "Bryggeri&#39;s &#x27;beste&#x27; øl &#248;l &amp; mer&nbsp;her",
      "https://rettfrabonden.com/produsent/hevd-handverksbakeri?ref=forside&utm_source=on",
      "http://eksempel.no/sok?sesong=vinter&stasjon=2#kart",
      "post@gardsbutikken.no",
      "kontakt+bestilling@ola-nordmann.no",
      "Tlf: +47 900 00 000",
      "Kontonr. 1234.56.78901 – Vipps 12345",
      "5 % rabatt ved henting; 2 for 1 på lørdag",
      "Pris: 120 kr/kg (min. 2 kg)",
      "Henting: tirsdag 17:00–19:00",
      "5 > 3 og 2 < 4",
      "Vi bruker JavaScript på nettsiden",
      "skript: java@script.no",
      "Online-butikk on the go",
      "Månedens tilbud: «Ost & kjeks»",
      "Linje 1\nLinje 2\r\n\tinnrykk",
      "",
    ];
    const ordinaryOut = sanitizeAll(ORDINARY);
    for (let i = 0; i < ORDINARY.length; i++) {
      assertEq(ordinaryOut[i], ORDINARY[i], `f1: ordinary text passes byte-identical — ${JSON.stringify(ORDINARY[i])}`);
      assertEq(mainOnce(ORDINARY[i]), ORDINARY[i], `f2: … exactly as on main — ${JSON.stringify(ORDINARY[i])}`);
    }
    // Text main ALREADY altered keeps main's result — nothing is widened or narrowed.
    const ALTERED_ON_MAIN = ["ons=fri", "a < b > c", "<b>fet</b> skrift", "Les mer: javascript:void(0)", "<img src=x onerror=alert(1)>Hei"];
    const alteredOut = sanitizeAll(ALTERED_ON_MAIN);
    for (let i = 0; i < ALTERED_ON_MAIN.length; i++) {
      assertEq(alteredOut[i], mainOnce(ALTERED_ON_MAIN[i]), `f3: text main already altered gets main's result — ${JSON.stringify(ALTERED_ON_MAIN[i])}`);
    }

    const seeds = seedDescriptions();
    assertTrue(seeds.length >= 600, `f4: the seed corpus is loaded (${seeds.length} real descriptions)`);
    const seedsOut = sanitizeAll(seeds);
    const seedDiff = seeds.findIndex((s, i) => seedsOut[i] !== s || mainOnce(s) !== s);
    assertEq(seedDiff, -1, `f5: every seed description is byte-identical after the filter, as on main${seedDiff >= 0 ? " — first: " + JSON.stringify(seeds[seedDiff]) : ""}`);

    const localeDir = path.join(REPO_ROOT, "src", "i18n", "locales");
    const locales = fs
      .readdirSync(localeDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .flatMap((f) => jsonStrings(JSON.parse(fs.readFileSync(path.join(localeDir, f), "utf8"))));
    assertTrue(locales.length >= 300, `f6: the locale corpus is loaded (${locales.length} UI strings)`);
    const localesOut = sanitizeAll(locales);
    const localeDiff = locales.findIndex((s, i) => localesOut[i] !== mainOnce(s));
    assertEq(localeDiff, -1, `f7: every locale string gets exactly main's result${localeDiff >= 0 ? " — first: " + JSON.stringify(locales[localeDiff]) : ""}`);

    const pageDir = path.join(REPO_ROOT, "tests", "fixtures", "field-spot-check");
    const pageFiles = fs.readdirSync(pageDir).filter((f) => f.endsWith(".html")).sort();
    assertTrue(pageFiles.length >= 10, `f8: the producer-page corpus is loaded (${pageFiles.length} real pages)`);
    const pages = pageFiles.map((f) => fs.readFileSync(path.join(pageDir, f), "utf8"));
    const pagesOut = sanitizeAll(pages);
    for (let i = 0; i < pages.length; i++) {
      assertEq(pagesOut[i], mainOnce(pages[i]), `f9: real producer page ${pageFiles[i]} gets exactly main's result`);
    }

    // ── (g) cost ─────────────────────────────────────────────────────────
    // Count passes through the real middleware: each pass runs the
    // javascript: replacement exactly once.
    const origReplace = String.prototype.replace;
    let jsPasses = 0;
    const countPasses = (list: string[]): number => {
      jsPasses = 0;
      (String.prototype as any).replace = function (this: string, ...args: any[]) {
        if (args[0] instanceof RegExp && args[0].source === "javascript:") jsPasses++;
        return (origReplace as any).apply(this, args);
      };
      try {
        sanitizeAll(list);
      } finally {
        (String.prototype as any).replace = origReplace;
      }
      return jsPasses;
    };
    assertEq(countPasses(ORDINARY), ORDINARY.length, "g1: text without a removal costs exactly one pass per string (as on main)");
    assertEq(countPasses(seeds), seeds.length, "g2: the seed corpus costs exactly one pass per string");
    assertEq(countPasses(["<b>fet</b>", "javascript:void(0)", "x onclick=y"]), 6, "g3: text with one removal costs one extra pass (two per string)");
    assertTrue(String.prototype.replace === origReplace, "g4: String.prototype.replace is restored");

    let t0 = Date.now();
    const ltRun = sanitize("<".repeat(200_000));
    const ltMs = Date.now() - t0;
    assertEq(ltRun.length, 200_000, "g5: a run of 200 000 \"<\" without \">\" is left as is (no tag)");
    assertTrue(ltMs < 2000, `g6: … in ${ltMs} ms (main: ~17 s — every "<" re-scanned the rest of the string)`);

    t0 = Date.now();
    const ltAndNest = sanitize("<".repeat(200_000) + at);
    const ltAndNestMs = Date.now() - t0;
    assertEq(ltAndNest, "", "g7: \"<\"-run plus a nest at the bound is dropped");
    assertTrue(ltAndNestMs < 2000, `g8: … in ${ltAndNestMs} ms (every one of the ${SANITIZE_MAX_PASSES} passes stays linear)`);

    const unit = at + " ";
    const megabyte = unit.repeat(Math.floor(1_000_000 / unit.length));
    t0 = Date.now();
    const megabyteOut = sanitize(megabyte);
    const megabyteMs = Date.now() - t0;
    assertEq(megabyteOut, "", "g9: a ~1 MB body string that is still changing on the last pass is dropped");
    assertTrue(megabyteMs < 2000, `g10: … in ${megabyteMs} ms (bounded: ${SANITIZE_MAX_PASSES} linear passes, not one per nesting level)`);
  } catch (err: any) {
    failed++;
    failures.push(
      "security-sanitize-fixpoint: unexpected error: " + String(err?.stack || err?.message || err),
    );
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/middleware/security-sanitize-fixpoint.test.ts`
if (require.main === module) {
  const summary = runSecuritySanitizeFixpointTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
