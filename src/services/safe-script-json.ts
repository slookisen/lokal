// ─── JSON inside an HTML <script> element ────────────────────────────────────
// dev-request 2026-10-17-jsonld-script-escaping-felles-serialiserer.
//
// JSON.stringify() is not safe on its own inside <script>. The HTML parser ends
// the element at the first `</script`, and a `<!--` followed by `<script` puts
// it in the "script data double escaped" state, where the real `</script>` no
// longer ends the element and the rest of the page is swallowed. The old
// `.replace(/<\//g, "<\\/")` only covered the first case. Titles, descriptions
// and names come partly from providers' own web pages via enrichment, so the
// operator does not fully control them.
//
// serializeJsonForScript() escapes every `<`, `>` and `&` plus U+2028 and
// U+2029 as \uXXXX. JSON outside strings never contains these characters, and
// inside a string they are ordinary escapes, so JSON.parse() (search engines,
// the map scripts' JSON.parse(textContent)) gives back the same value. U+2028
// and U+2029 are valid in JSON but were line terminators in JavaScript before
// ES2019, which matters when the result is a value in an inline script.
// Without any of the five characters the output is byte-identical to
// JSON.stringify().

const SCRIPT_UNSAFE_CHARS = /[<>&\u2028\u2029]/g;
const SCRIPT_ESCAPES: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/** JSON.stringify(value) that is safe as the content of a <script> element. */
export function serializeJsonForScript(value: unknown): string {
  const json = JSON.stringify(value);
  // undefined, a function or a symbol has no JSON text to embed.
  if (json === undefined) throw new TypeError("serializeJsonForScript: value has no JSON representation");
  return json.replace(SCRIPT_UNSAFE_CHARS, (c) => SCRIPT_ESCAPES[c]);
}

/** One complete `<script type="application/ld+json">` element for a JSON-LD node. */
export function jsonLdScriptTag(value: unknown): string {
  return `<script type="application/ld+json">${serializeJsonForScript(value)}</script>`;
}
