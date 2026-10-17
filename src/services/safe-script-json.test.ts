/**
 * safe-script-json.test.ts — dev-request
 * 2026-10-17-jsonld-script-escaping-felles-serialiserer: one serializer for
 * JSON inside <script> (src/services/safe-script-json.ts), and a source scan
 * that keeps every JSON <script> in src/routes on it.
 *
 * Covers:
 *   (a) round trip: JSON.parse(serializeJsonForScript(v)) equals v for strings
 *       with `</script>`, `<!--<script>`, `&`, U+2028/U+2029, æøå and more,
 *       and for a nested object; the result also evaluates as a JavaScript
 *       expression to the same value (inline-script use).
 *   (b) each of `<`, `>`, `&`, U+2028 and U+2029 becomes its \uXXXX escape,
 *       and none of the five is left raw in the output.
 *   (c) without any of the five characters the output is byte-identical to
 *       JSON.stringify(), so a switch changes no bytes for such content.
 *   (d) jsonLdScriptTag() is exactly one `<script type="application/ld+json">`
 *       element around serializeJsonForScript(); a value with no JSON text
 *       (undefined, a function) throws instead of embedding "undefined".
 *   (e) parser view (tests/helpers/html-script-elements.ts): with the old
 *       `</`-only escape, `<!--<script>` in a value swallows the rest of the
 *       page (one unclosed element); with the helper, every element ends
 *       where it should and each JSON block parses.
 *   (f) source scan over src/routes (non-test .ts): no `.replace(/<\//g`
 *       idiom; every literal `<script type="application/ld+json">` or
 *       `<script type="application/json" …>` is filled directly by
 *       serializeJsonForScript() (RFB seo.ts keeps its own `<` escape, see
 *       LEGACY_LT_ESCAPE_FILES); experiences-seo.ts and dental-seo.ts
 *       interpolate no raw JSON.stringify() at all. The scanner is checked
 *       against synthetic offenders first, so it cannot pass by seeing
 *       nothing.
 *
 * Run standalone: npx tsx src/services/safe-script-json.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { serializeJsonForScript, jsonLdScriptTag } from "./safe-script-json";
import { scriptElements } from "../../tests/helpers/html-script-elements";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ROUTES_DIR = path.join(__dirname, "..", "routes");

// A literal JSON <script> start tag in route source.
const JSON_SCRIPT_TAG = /<script type="application\/(?:ld\+)?json"[^>]*>/g;
// The old escape that only covered `</`: `.replace(/<\//g, "<\\/")`.
const WEAK_ESCAPE = /\.replace\(\s*\/<\\\/\/g/;
// RFB's seo.ts keeps `JSON.stringify(x).replace(/</g, "\\u003c")`. It already
// escapes every `<`, which is what stops the script-state bug, and its JSON-LD
// carries producer text that often contains `&`, so moving it to the shared
// helper would change bytes. The dev-request leaves it untouched in that case.
const LEGACY_LT_ESCAPE = /^\$\{JSON\.stringify\([\w.]+\)\.replace\(\/<\/g, "\\\\u003c"\)\}<\/script>/;
const LEGACY_LT_ESCAPE_FILES = new Set(["seo.ts"]);
// The two sites this dev-request moved off raw JSON.stringify(), including
// JSON values written into inline scripts.
const NO_RAW_STRINGIFY_FILES = ["experiences-seo.ts", "dental-seo.ts"];

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

/** Every JSON <script> in `src` that does not go through serializeJsonForScript(), as "file:line: why". */
export function scriptJsonOffenders(file: string, src: string): string[] {
  const out: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (WEAK_ESCAPE.test(line)) out.push(`${file}:${i + 1}: escapes only "</" (.replace(/<\\//g …))`);
    for (const m of line.matchAll(JSON_SCRIPT_TAG)) {
      const rest = line.slice((m.index ?? 0) + m[0].length);
      if (rest.startsWith("${serializeJsonForScript(")) continue;
      if (LEGACY_LT_ESCAPE_FILES.has(file) && LEGACY_LT_ESCAPE.test(rest)) continue;
      out.push(`${file}:${i + 1}: ${m[0]} is not filled by serializeJsonForScript()`);
    }
  });
  return out;
}

/** Lines of `src` that interpolate a raw JSON.stringify() into a template. */
function rawStringifyLines(file: string, src: string): string[] {
  return src.split("\n").flatMap((line, i) => (!isCommentLine(line) && line.includes("${JSON.stringify(") ? [`${file}:${i + 1}`] : []));
}

function routeSources(): Array<{ file: string; src: string }> {
  return fs.readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .sort()
    .map((file) => ({ file, src: fs.readFileSync(path.join(ROUTES_DIR, file), "utf8") }));
}

export function runSafeScriptJsonTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const LS = "\u2028";
  const PS = "\u2029";
  const DANGEROUS = [
    "</script>",
    "<!--<script>",
    "<!--<script></script>-->",
    "X</script><script>alert(1)</script><!--<script>&\"'",
    "<\\/script>",
    "-->",
    "]]>",
    "a & b &amp; c &lt;",
    `linje${LS}skille${PS}avsnitt`,
    "<b>fet</b> > 2",
  ];
  const PLAIN = [
    "Hvalsafari fra Tromsø",
    "æøå ÆØÅ «sitat» — tankestrek",
    "\"anførsel\" og \\ skråstrek",
    "tab\tog\nny linje",
    "emoji 🎉 og \u0000 kontrolltegn",
    "",
  ];
  const nested = {
    "@context": "https://schema.org",
    "@type": "TouristAttraction",
    name: "<!--<script>Hval & sel",
    list: ["</script>", { deep: `&${LS}${PS}<>` }, 1.5, true, null],
    address: { addressLocality: "Tromsø" },
  };

  // ── (a) round trip ─────────────────────────────────────────────────────
  for (const v of [...DANGEROUS, ...PLAIN]) {
    assertEq(JSON.parse(serializeJsonForScript(v)), v, `ssj-a1: JSON.parse round trip for ${JSON.stringify(v)}`);
  }
  assertEq(JSON.parse(serializeJsonForScript(nested)), nested, "ssj-a2: JSON.parse round trip for a nested JSON-LD object");
  assertEq(JSON.parse(serializeJsonForScript([nested, nested])), [nested, nested], "ssj-a3: … and for an array of them");
  assertEq(vm.runInNewContext(`(${serializeJsonForScript(nested)})`), nested,
    "ssj-a4: the output is a JavaScript expression with the same value (inline-script use)");
  assertEq(vm.runInNewContext(`(${serializeJsonForScript(`a${LS}b${PS}c`)})`), `a${LS}b${PS}c`,
    "ssj-a5: … also for a string with U+2028/U+2029");

  // ── (b) the five escapes ───────────────────────────────────────────────
  assertEq(serializeJsonForScript("<"), "\"\\u003c\"", "ssj-b1: < becomes \\u003c");
  assertEq(serializeJsonForScript(">"), "\"\\u003e\"", "ssj-b2: > becomes \\u003e");
  assertEq(serializeJsonForScript("&"), "\"\\u0026\"", "ssj-b3: & becomes \\u0026");
  assertEq(serializeJsonForScript(LS), "\"\\u2028\"", "ssj-b4: U+2028 becomes \\u2028");
  assertEq(serializeJsonForScript(PS), "\"\\u2029\"", "ssj-b5: U+2029 becomes \\u2029");
  assertEq(serializeJsonForScript("<!--<script>"), "\"\\u003c!--\\u003cscript\\u003e\"", "ssj-b6: <!--<script> becomes \\u003c!--\\u003cscript\\u003e");
  {
    const all = [...DANGEROUS.map((v) => serializeJsonForScript(v)), serializeJsonForScript(nested)].join("");
    assertTrue(!all.includes("<"), "ssj-b7: no raw < in any output");
    assertTrue(!all.includes(">"), "ssj-b8: no raw > in any output");
    assertTrue(!all.includes("&"), "ssj-b9: no raw & in any output");
    assertTrue(!all.includes(LS), "ssj-b10: no raw U+2028 in any output");
    assertTrue(!all.includes(PS), "ssj-b11: no raw U+2029 in any output");
    assertTrue(!all.includes("<\\/"), "ssj-b12: no <\\/ left in any output");
  }

  // ── (c) byte-identical without the five characters ─────────────────────
  for (const v of PLAIN) {
    assertEq(serializeJsonForScript(v), JSON.stringify(v), `ssj-c1: byte-identical to JSON.stringify for ${JSON.stringify(v)}`);
  }
  {
    const plainLd = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Forsiden", item: "https://opplevagent.no" }] };
    assertEq(serializeJsonForScript(plainLd), JSON.stringify(plainLd), "ssj-c2: byte-identical for a plain JSON-LD object");
  }

  // ── (d) jsonLdScriptTag() and values without JSON text ─────────────────
  assertEq(jsonLdScriptTag({ "@type": "Thing", name: "<b>&" }),
    "<script type=\"application/ld+json\">{\"@type\":\"Thing\",\"name\":\"\\u003cb\\u003e\\u0026\"}</script>",
    "ssj-d1: jsonLdScriptTag() is one ld+json element around serializeJsonForScript()");
  assertEq(jsonLdScriptTag(nested), `<script type="application/ld+json">${serializeJsonForScript(nested)}</script>`,
    "ssj-d2: … for a nested object too");
  for (const [label, v] of [["undefined", undefined], ["a function", () => 1]] as const) {
    let threw: unknown = null;
    try { serializeJsonForScript(v); } catch (err) { threw = err; }
    assertTrue(threw instanceof TypeError, `ssj-d3: ${label} has no JSON text → TypeError, never the text "undefined"`);
  }

  // ── (e) parser view ────────────────────────────────────────────────────
  {
    const weak = (v: unknown): string => (JSON.stringify(v) as string).replace(/<\//g, "<\\/");
    const page = (block: string): string =>
      `<html><head><title>T</title>\n${block}\n<script type="application/ld+json">{"@type":"WebSite"}</script></head>` +
      `<body><main>Innhold</main><script>var ok = 1;</script></body></html>`;
    const value = { "@type": "TouristAttraction", name: "Hval <!--<script> & sel" };

    const before = scriptElements(page(`<script type="application/ld+json">${weak(value)}</script>`));
    assertTrue(before.length === 1 && !before[0].closed,
      `ssj-e1: oracle — with the old </-only escape the parser swallows the rest of the page (${before.length} element(s), closed=${before[0]?.closed})`);

    const after = scriptElements(page(jsonLdScriptTag(value)));
    assertTrue(after.length === 3 && after.every((e) => e.closed), `ssj-e2: with the helper the page has its 3 script elements, all closed (got ${after.length})`);
    assertEq(after[0] ? JSON.parse(after[0].content) : null, value, "ssj-e3: … the first block parses back to the value");
    assertEq(after[1] ? JSON.parse(after[1].content) : null, { "@type": "WebSite" }, "ssj-e4: … the next ld+json block is intact");
    assertEq(after[2]?.content, "var ok = 1;", "ssj-e5: … and so is the page's own script");

    for (const v of DANGEROUS) {
      const els = scriptElements(page(jsonLdScriptTag({ name: v })));
      assertTrue(els.length === 3 && els.every((e) => e.closed) && JSON.parse(els[0].content).name === v,
        `ssj-e6: ${JSON.stringify(v)} in a value leaves 3 closed elements and round-trips`);
    }
    // The oracle itself: an escaped comment alone does not hide the end tag;
    // after <!--<script> the next </script> only leaves the double-escaped
    // state, the one after it ends the element; `-->` ends the escape.
    assertEq(scriptElements("<script>a<!--b</script><p>").map((e) => [e.content, e.closed]), [["a<!--b", true]],
      "ssj-e7: oracle — <!-- alone does not hide </script>");
    assertEq(scriptElements("<script>a<!--<script>b</script>c</script>d").map((e) => [e.content, e.closed]),
      [["a<!--<script>b</script>c", true]],
      "ssj-e8: oracle — <!--<script> hides the next </script>; the one after it ends the element");
    assertEq(scriptElements("<script>a<!--<script>b-->c</script>d").map((e) => [e.content, e.closed]),
      [["a<!--<script>b-->c", true]],
      "ssj-e8b: oracle — --> ends the escape, so the next </script> ends the element");
    assertEq(scriptElements("<p><!-- <script>x</script> --></p><SCRIPT>y</SCRIPT >").map((e) => [e.content, e.closed]), [["y", true]],
      "ssj-e9: oracle — skips HTML comments outside scripts; end tags are case-insensitive");
  }

  // ── (f) source scan over src/routes ────────────────────────────────────
  {
    // The scanner first, on synthetic sources.
    const LD = "<script type=\"application/ld+json\">";
    const samples: Array<[string, string, number]> = [
      ["x.ts", "  const ld = `" + LD + "${JSON.stringify(o)}</script>`;", 1],
      ["x.ts", "  .map((o) => `" + LD + "${JSON.stringify(o).replace(/<\\//g, \"<\\\\/\")}</script>`)", 2],
      ["x.ts", "  : `" + LD + "{\"@type\":\"CollectionPage\",\"url\":\"${url}\"}</script>`;", 1],
      ["x.ts", "    <script type=\"application/json\" id=\"fylke-map-data\">${dataJson}</script>", 1],
      ["x.ts", "  const dataJson = JSON.stringify(markers).replace(/<\\//g, \"<\\\\/\");", 1],
      ["x.ts", "    <script type=\"application/json\" id=\"fylke-map-data\">${serializeJsonForScript(markers)}</script>", 0],
      ["x.ts", "  const ld = jsonLdScriptTag(o);", 0],
      ["x.ts", " * a " + LD + " block whose content", 0],
      ["x.ts", "  // " + LD + "${JSON.stringify(o)}</script>", 0],
      ["seo.ts", "  extra.jsonLd.map(j => `" + LD + "${JSON.stringify(j).replace(/</g, \"\\\\u003c\")}</script>`)", 0],
      ["x.ts", "  extra.jsonLd.map(j => `" + LD + "${JSON.stringify(j).replace(/</g, \"\\\\u003c\")}</script>`)", 1],
    ];
    samples.forEach(([file, src, n], i) => {
      const got = scriptJsonOffenders(file, src);
      assertTrue(got.length === n, `ssj-f0.${i + 1}: scanner reports ${n} offender(s) for ${JSON.stringify(src.trim())} in ${file} (got ${JSON.stringify(got)})`);
    });
    assertEq(rawStringifyLines("x.ts", "  var id = ${JSON.stringify(provider.id)};\n  // ${JSON.stringify(x)}\n  var ok = ${serializeJsonForScript(x)};"),
      ["x.ts:1"], "ssj-f0.12: raw-stringify scanner finds the inline-script value, skips comments and the helper");

    // Then the real tree.
    const sources = routeSources();
    assertTrue(sources.length > 50 && sources.some((s) => s.file === "experiences-seo.ts") && sources.some((s) => s.file === "dental-seo.ts"),
      `ssj-f1: scanned ${sources.length} route files, experiences-seo.ts and dental-seo.ts among them`);
    assertEq(sources.flatMap((s) => scriptJsonOffenders(s.file, s.src)), [],
      "ssj-f2: every JSON <script> in src/routes goes through serializeJsonForScript() and no route escapes only \"</\"");
    const tagCount = (file: string): number => {
      const s = sources.find((x) => x.file === file);
      return s ? s.src.split("\n").filter((l) => !isCommentLine(l)).reduce((n, l) => n + [...l.matchAll(JSON_SCRIPT_TAG)].length, 0) : 0;
    };
    assertEq([tagCount("experiences-seo.ts"), tagCount("handleliste-page.ts"), tagCount("seo.ts")], [3, 1, 2],
      "ssj-f3: the scan sees the literal JSON scripts that remain (3 OA map islands, the handleliste copy, RFB's 2 ld+json)");
    for (const file of ["experiences-seo.ts", "dental-seo.ts", "agentplatform-site.ts"]) {
      const src = sources.find((s) => s.file === file)?.src ?? "";
      assertTrue(/import \{[^}]*\bjsonLdScriptTag\b[^}]*\} from "\.\.\/services\/safe-script-json"/.test(src) && src.includes("jsonLdScriptTag("),
        `ssj-f4: ${file} builds its ld+json elements with jsonLdScriptTag()`);
    }
    assertEq(NO_RAW_STRINGIFY_FILES.flatMap((file) => rawStringifyLines(file, sources.find((s) => s.file === file)?.src ?? "")), [],
      "ssj-f5: experiences-seo.ts and dental-seo.ts interpolate no raw JSON.stringify() (inline-script values included)");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/safe-script-json.test.ts`
if (require.main === module) {
  console.log("── safe-script-json: one serializer for JSON in <script> (dev-request 2026-10-17) ──");
  const r = runSafeScriptJsonTests({ log: true });
  console.log(`\nsafe-script-json: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
