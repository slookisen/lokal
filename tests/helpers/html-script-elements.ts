/**
 * The <script> elements of an HTML page as the HTML parser sees them.
 *
 * dev-request 2026-10-17-jsonld-script-escaping-felles-serialiserer. A regex
 * such as jsonLdBlocks()'s `<script …>([\s\S]*?)</script>` ends every element
 * at the next `</script>`, so it cannot see the bug that dev-request fixes:
 * after `<!--<script` inside a script, the parser is in the "script data
 * double escaped" state and the next `</script>` does NOT end the element.
 * scriptElements() follows the tokenizer's script data states (WHATWG HTML,
 * "Tokenization", script data state through script data double escape end
 * state) to find where each element really ends.
 *
 * Outside scripts it skips <!-- comments --> and treats the rest as ordinary
 * markup. That holds for the pages under test: their text is HTML-escaped, so
 * no `<script` hides in a <title>, <textarea> or attribute.
 */

export interface ScriptElement {
  /** The start tag, e.g. `<script type="application/ld+json">`. */
  startTag: string;
  /** The raw text from the start tag to where the parser ends the element. */
  content: string;
  /** False when the parser finds no end: the rest of the page was swallowed. */
  closed: boolean;
}

const isDelimiter = (c: string | undefined): boolean =>
  c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " " || c === "/" || c === ">";

/** True when a `</script` end tag (case-insensitive, then a delimiter) starts at `i`. */
function scriptEndTagAt(html: string, i: number): boolean {
  return html.slice(i, i + 8).toLowerCase() === "</script" && isDelimiter(html[i + 8]);
}

/** The ASCII-letter run starting at `i`, lower-cased, and the index after it. */
function tagNameAt(html: string, i: number): { name: string; next: number } {
  let k = i;
  while (k < html.length && /[A-Za-z]/.test(html[k])) k++;
  return { name: html.slice(i, k).toLowerCase(), next: k };
}

type ScriptDataState =
  | "data"
  | "escaped" | "escapedDash" | "escapedDashDash"
  | "doubleEscaped" | "doubleEscapedDash" | "doubleEscapedDashDash";

/** Index of the `<` of the end tag that ends the script element whose content starts at `from`, or -1. */
function scriptContentEnd(html: string, from: number): number {
  let state: ScriptDataState = "data";
  let i = from;
  while (i < html.length) {
    const c = html[i];
    if (state === "data") {
      if (c === "<" && scriptEndTagAt(html, i)) return i;
      // "<!--" goes through escape start / escape start dash to escaped dash dash.
      if (c === "<" && html.startsWith("<!--", i)) { state = "escapedDashDash"; i += 4; continue; }
      i++;
      continue;
    }
    if (state === "escaped" || state === "escapedDash" || state === "escapedDashDash") {
      if (c === "-") { state = state === "escaped" ? "escapedDash" : "escapedDashDash"; i++; continue; }
      if (c === ">" && state === "escapedDashDash") { state = "data"; i++; continue; }
      if (c === "<") {
        // Escaped less-than sign: `</script` still ends the element here.
        if (scriptEndTagAt(html, i)) return i;
        if (/[A-Za-z]/.test(html[i + 1] ?? "")) {
          // Double escape start: `<script` + delimiter enters double escaped.
          const { name, next } = tagNameAt(html, i + 1);
          const d = html[next];
          if (isDelimiter(d)) { state = name === "script" ? "doubleEscaped" : "escaped"; i = next + 1; continue; }
          state = "escaped";
          i = next;
          continue;
        }
      }
      state = "escaped";
      i++;
      continue;
    }
    // Double escaped: `</script` only switches back to escaped.
    if (c === "-") { state = state === "doubleEscaped" ? "doubleEscapedDash" : "doubleEscapedDashDash"; i++; continue; }
    if (c === ">" && state === "doubleEscapedDashDash") { state = "data"; i++; continue; }
    if (c === "<" && html[i + 1] === "/") {
      const { name, next } = tagNameAt(html, i + 2);
      const d = html[next];
      if (isDelimiter(d)) { state = name === "script" ? "escaped" : "doubleEscaped"; i = next + 1; continue; }
      state = "doubleEscaped";
      i = next;
      continue;
    }
    state = "doubleEscaped";
    i++;
  }
  return -1;
}

/** Every <script> element on the page, ended where the HTML parser ends it. */
export function scriptElements(html: string): ScriptElement[] {
  const out: ScriptElement[] = [];
  const tagRe = /<!--[\s\S]*?-->|<script\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    const start = m.index + m[0].length;
    const end = scriptContentEnd(html, start);
    out.push({ startTag: m[0], content: html.slice(start, end < 0 ? html.length : end), closed: end >= 0 });
    if (end < 0) break;
    const close = html.indexOf(">", end);
    tagRe.lastIndex = close < 0 ? html.length : close + 1;
  }
  return out;
}

/** How many times `<script` (case-insensitive, as a tag name) occurs anywhere in the page text. */
export function scriptStartTagCount(html: string): number {
  return (html.match(/<script\b/gi) || []).length;
}
