/**
 * HTML checks for page tests that put API values into markup: entities to
 * text, the start tags as a browser tokenizes them, and what an injected value
 * would have added to a fragment (a foreign tag, an on* handler, a foreign
 * href).
 *
 * dev-request 2026-10-17-integrasjonstest-oppfolging: moved here from
 * src/routes/rfb-produsentmodal-apningstider-escaping.test.ts (I-I) so the
 * producer modal (I-I) and the card grid, search suggestions, admin alert and
 * seller match list (I-K) are read the same way. Unchanged in the move.
 */

import * as fs from "fs";
import * as path from "path";

const PUBLIC_DIR = path.join(__dirname, "..", "..", "src", "public");

/** HTML entities to text (the ones the pages and seo.ts write, and numeric ones). */
export function decode(html: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", middot: "·", rarr: "→", mdash: "—" };
  return html.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return named[e.toLowerCase()] ?? m;
  });
}

/** The visible text of an HTML fragment: tags removed, entities decoded. */
export function visibleText(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " "));
}

export interface StartTag { name: string; attrs: Array<[string, string]> }

/**
 * Every start tag with its attributes, read the way a browser tokenizes a
 * start tag (quoted values may hold spaces and "="), so an attribute that
 * stays inside a quoted value is not taken for one of its own.
 */
export function startTags(html: string): StartTag[] {
  const tags: StartTag[] = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)/g;
  const attrRe = /\s*([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    let i = m.index + m[0].length;
    const attrs: Array<[string, string]> = [];
    for (;;) {
      attrRe.lastIndex = i;
      const a = attrRe.exec(html);
      if (!a || !a[0].length) break;
      attrs.push([a[1]!.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? "")]);
      i = attrRe.lastIndex;
    }
    tags.push({ name: m[1]!.toLowerCase(), attrs });
    tagRe.lastIndex = i;
  }
  return tags;
}

/** What is wrong with an HTML fragment: a tag outside `allowed`, an on* attribute, an href outside `hrefs`. */
export function injectionProblems(html: string, allowed: ReadonlySet<string>, hrefs: readonly RegExp[]): string[] {
  const problems: string[] = [];
  for (const tag of startTags(html)) {
    if (!allowed.has(tag.name)) problems.push(`tag <${tag.name}>`);
    for (const [name, value] of tag.attrs) {
      if (name.startsWith("on")) problems.push(`attribute ${name} on <${tag.name}>`);
      if (name === "href" && !hrefs.some((re) => re.test(value))) problems.push(`href ${JSON.stringify(value)}`);
      if (name === "src" || name === "srcdoc" || name === "style" && /expression|url\(/i.test(value)) problems.push(`attribute ${name} on <${tag.name}>`);
    }
  }
  return problems;
}

/** "[object Object]", "undefined", "NaN" or "Invalid Date" in the visible text. */
export function junk(html: string): string[] {
  return [...visibleText(html).matchAll(/.{0,30}(\[object Object\]|\bundefined\b|\bNaN\b|Invalid Date).{0,15}/g)].map((m) => m[0]);
}

/** The inline <script> of a page in src/public that defines `marker`. */
export function inlineScript(file: string, marker: string): string {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((s) => s.includes(marker));
  if (!script) throw new Error(`${file}: no inline script with ${marker}`);
  return script;
}
