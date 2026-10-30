// ─── Product import: price ↔ name association on the page (PURE) ────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, «Rettinger i
// uthenteren, runde 2» (prod measurement 2026-10-30, 91.2 % correct; A2A
// reports/2026-10-30-produktimport-maaling-2.md). The LLM tier's grounding
// (./llm.ts) only proves a price's NUMBER is somewhere in the source text.
// The three wrong hits were all a real number at the wrong product:
//
//   1 ovrejorde.no: each product is a column with the price button ABOVE the
//     name. «Bog» got 150 (the next column, «Kje Kjøttdeig»), not its 269.
//   2 henrikshonning.no: «Sommerhonning eller Høsthonning / 500 grams glass
//     kr 130,-» was given to «Byhonning», which has no price.
//   3 henrikshonning.no: a 2022 blog post with an old price list.
//
// So a model price is kept for a name only when the page itself puts it
// there, decided here in code from the page's element structure:
//
//   • the price's PRODUCT BLOCK is the lowest element around it that holds
//     any known product name. When that block names only this product, the
//     price is its own (same element/line, or price above the name in one
//     card) — within PRICE_NAME_MAX_DISTANCE characters;
//   • when that block names only ANOTHER product, the price is that
//     product's — never this one's (fix 1);
//   • when it names several (a plain list, one paragraph), reading order
//     decides: the price belongs to the nearest name BEFORE it. A shared
//     price «X eller Y … kr N» belongs to every name joined by «eller» on
//     the anchor's line, and to no other product on the page (fix 2);
//   • a page that is a blog post (date in the URL like /2022/06/, or
//     article markup with a publish date, BlogPosting/Article JSON-LD) is
//     never a price source; the product may be kept without price (fix 3).
//
// When the model's price is not at the name but the name's OWN product block
// (the largest element around the name that names no other product — the
// card) shows exactly one NOK price, near the name, that price is used
// instead, verbatim from the page (rule price_reanchored; the model's string
// stays in raw_price_text). This is what gives «Bog» its 269.
//
// Every decision is recorded in the candidate's `rules` (./rules.ts):
// price_not_at_name, price_reanchored, price_blog_source_dropped,
// price_excl_vat.

import { decodeHtmlEntities } from "../description-quality";
import {
  nokPriceValues,
  numberTokensInText,
  parseNokPrice,
  productNameKey,
  roundNok,
  statesExclVat,
  statesPagePricesExclVat,
  statesUnitPrice,
} from "./normalize";
import { dropPrice, markExclVat } from "./rules";
import { collectNodes, hasType, type ProductCandidate } from "./structured";

/** A price further than this (characters of visible text) from its name is not at the name. */
export const PRICE_NAME_MAX_DISTANCE = 300;

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "button", "dd", "div", "dl", "dt", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
/** Opening one of these closes an open element of the same tag (HTML's implied end tags). */
const SELF_NESTING_CLOSES = new Set(["li", "p", "tr", "td", "th", "dt", "dd", "option"]);

interface BlockNode {
  tag: string;
  parent: number;
  start: number;
  end: number;
}

/** A page as visible text plus the element tree over it (character ranges). */
export interface PageBlocks {
  text: string;
  nodes: BlockNode[];
  /** Text runs and the innermost element each lies in, in text order. */
  runs: Array<{ start: number; end: number; node: number }>;
  /** Number tokens of `text`, computed once on first use (pageNumberTokens). */
  numberTokens?: Array<{ value: number; index: number; length: number }>;
}

function pageNumberTokens(page: PageBlocks): Array<{ value: number; index: number; length: number }> {
  if (!page.numberTokens) page.numberTokens = numberTokensInText(page.text);
  return page.numberTokens;
}

/** Longest attribute section read for one tag (srcset/data-* JSON fit well inside). */
const TAG_ATTR_SCAN_CAP = 8000;
/** How far down the open-element stack a closing tag looks for its opener. */
const CLOSE_SEARCH_DEPTH = 256;

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isTagNameChar(c: number): boolean {
  return isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 45; // letters, digits, «-»
}

/**
 * Visible text of an HTML page with its element tree: every element's
 * [start, end) range in the text. Block elements are separated by "\n"
 * (one line ≈ one element), inline ones by a space — the same visible text
 * pageTextOf() gives the model, up to whitespace. PURE; never throws.
 */
export function parsePageBlocks(html: string): PageBlocks {
  const cleaned = (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const nodes: BlockNode[] = [{ tag: "#root", parent: -1, start: 0, end: 0 }];
  const runs: PageBlocks["runs"] = [];
  const stack: number[] = [0];
  // Built as parts with the length and last character tracked in variables:
  // reading the tail of one ever-growing string re-flattens it in V8 and
  // made a 2 MB page take tens of seconds (review of 76bf1b5).
  const parts: string[] = [];
  let len = 0;
  let lastCh = "";
  const sep = (ch: " " | "\n") => {
    if (len === 0 || lastCh === "\n") return;
    if (lastCh === " ") {
      if (ch === "\n") {
        const i = parts.length - 1;
        parts[i] = parts[i]!.slice(0, -1) + "\n";
        lastCh = "\n";
      }
      return;
    }
    parts.push(ch);
    len += 1;
    lastCh = ch;
  };
  const addText = (raw: string) => {
    let t = decodeHtmlEntities(raw).replace(/[\s\u00a0]+/g, " ");
    if (!t.trim()) {
      if (t) sep(" ");
      return;
    }
    if (len === 0 || lastCh === " " || lastCh === "\n") t = t.replace(/^ /, "");
    const start = len;
    parts.push(t);
    len += t.length;
    lastCh = t[t.length - 1]!;
    const lead = t.length - t.trimStart().length;
    const trail = t.length - t.trimEnd().length;
    runs.push({ start: start + lead, end: len - trail, node: stack[stack.length - 1]! });
  };
  const closeTo = (idx: number) => {
    while (stack.length - 1 >= idx && stack.length > 1) {
      const id = stack.pop()!;
      nodes[id]!.end = len;
    }
  };
  // Tags are read by a small linear scanner, not a regex: an attribute value
  // may hold a raw «<» or «>» (`x-show="i < 3"`, `:disabled="qty <= 1"`),
  // so quotes after «=» are tracked until an unquoted «>». A «<» whose tag
  // never closes is text. Linear on adversarial input: one attribute walk
  // is capped, the walks share a budget, and a walk that reaches the end of
  // the input ends tag recognition (the rest of the page is text).
  const L = cleaned.length;
  let budget = L * 4 + 1_000_000;
  let last = 0;
  let pos = 0;
  while (pos < L) {
    const lt = cleaned.indexOf("<", pos);
    if (lt < 0) break;
    let j = lt + 1;
    const closing = cleaned.charCodeAt(j) === 47; // «/»
    if (closing) j++;
    if (!isAsciiLetter(cleaned.charCodeAt(j))) {
      pos = lt + 1;
      continue;
    }
    let k = j + 1;
    while (k < L && isTagNameChar(cleaned.charCodeAt(k))) k++;
    const tag = cleaned.slice(j, k).toLowerCase();
    let quote = "";
    let prev = "";
    let end = -1;
    let m = k;
    const cap = Math.min(L, k + TAG_ATTR_SCAN_CAP);
    for (; m < cap; m++) {
      const ch = cleaned[m]!;
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === ">") {
        end = m;
        break;
      }
      if ((ch === '"' || ch === "'") && prev === "=") quote = ch;
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r" && ch !== "\f") prev = ch;
    }
    budget -= m - k + 1;
    if (end < 0) {
      if (m >= L || budget < 0) break; // no closing «>» anywhere ahead: the rest is text
      pos = lt + 1;
      continue;
    }
    addText(cleaned.slice(last, lt));
    last = end + 1;
    pos = end + 1;
    sep(BLOCK_TAGS.has(tag) ? "\n" : " ");
    if (closing) {
      // Bounded search: a page of unclosed tags must not make this quadratic.
      for (let i = stack.length - 1; i >= 1 && i >= stack.length - CLOSE_SEARCH_DEPTH; i--) {
        if (nodes[stack[i]!]!.tag === tag) {
          closeTo(i);
          break;
        }
      }
      continue;
    }
    if (VOID_TAGS.has(tag) || cleaned[end - 1] === "/") continue;
    if (SELF_NESTING_CLOSES.has(tag) && stack.length > 1 && nodes[stack[stack.length - 1]!]!.tag === tag) {
      closeTo(stack.length - 1);
    }
    nodes.push({ tag, parent: stack[stack.length - 1]!, start: len, end: len });
    stack.push(nodes.length - 1);
  }
  addText(cleaned.slice(last));
  closeTo(1);
  const text = parts.join("");
  nodes[0]!.end = text.length;
  return { text, nodes, runs };
}

/** The innermost element at a text index (the root when between runs). */
function nodeAt(page: PageBlocks, index: number): number {
  let lo = 0;
  let hi = page.runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = page.runs[mid]!;
    if (index < r.start) hi = mid - 1;
    else if (index >= r.end) lo = mid + 1;
    else return r.node;
  }
  return 0;
}

export interface NameOccurrence {
  key: string;
  start: number;
  end: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every occurrence of the given names in the page text, as whole words
 * (case-insensitive, any whitespace), in text order. An occurrence inside a
 * longer name's occurrence («Lam» in «Lam med ben») belongs to the longer
 * name. PURE.
 */
export function findNameOccurrences(text: string, names: string[]): NameOccurrence[] {
  const keys = new Map<string, string>();
  for (const n of names) {
    const k = productNameKey(n);
    if (k && !keys.has(k)) keys.set(k, n.trim());
  }
  const all: NameOccurrence[] = [];
  for (const [key, name] of keys) {
    const body = name.split(/\s+/).filter(Boolean).map(escapeRe).join("\\s+");
    if (!body) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) all.push({ key, start: m.index!, end: m.index! + m[0].length });
  }
  // Sort by start, longer first on ties, then sweep: an occurrence is inside
  // a longer one exactly when an earlier occurrence reaches at least as far
  // (the furthest-reaching one is such a container). O(n log n).
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: NameOccurrence[] = [];
  let maxEnd = -1;
  for (const o of all) {
    if (o.end <= maxEnd) continue;
    out.push(o);
    maxEnd = o.end;
  }
  return out;
}

function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

/**
 * Where on the page `value` stands as the price OF the name `key`, by the
 * rules in the header; -1 when it never does. `occs` are all known product
 * names on the page (findNameOccurrences). PURE.
 */
export function findPriceAtName(page: PageBlocks, occs: NameOccurrence[], key: string, value: number): number {
  if (!occs.some((o) => o.key === key)) return -1;
  const target = roundNok(value);
  for (const tok of pageNumberTokens(page)) {
    if (roundNok(tok.value) !== target) continue;
    // A number inside a name («Poteter 10 kg») is not a price.
    if (occs.some((o) => tok.index >= o.start && tok.index < o.end)) continue;
    // The product block: lowest element around the price that holds a name.
    let n = nodeAt(page, tok.index);
    let inBlock: NameOccurrence[] = [];
    for (; n >= 0; n = page.nodes[n]!.parent) {
      const node = page.nodes[n]!;
      inBlock = occs.filter((o) => o.start >= node.start && o.start < node.end);
      if (inBlock.length > 0) break;
    }
    const keys = new Set(inBlock.map((o) => o.key));
    if (keys.size === 1) {
      if (!keys.has(key)) continue; // another product's own block
      const near = inBlock.some(
        (o) => Math.abs(tok.index - o.start) <= PRICE_NAME_MAX_DISTANCE || Math.abs(tok.index - o.end) <= PRICE_NAME_MAX_DISTANCE,
      );
      if (near) return tok.index;
      continue;
    }
    // Several products in one block: the nearest name before the price.
    let anchor: NameOccurrence | null = null;
    for (const o of occs) {
      if (o.end <= tok.index) anchor = o;
      else break;
    }
    if (!anchor || tok.index - anchor.end > PRICE_NAME_MAX_DISTANCE) continue;
    if (anchor.key === key) return tok.index;
    // «X eller Y … kr N»: the names joined by «eller» on the anchor's line.
    const lineStart = lineStartOf(page.text, anchor.start);
    const shared = occs.some(
      (o) =>
        o.key === key &&
        o.start >= lineStart &&
        o.end <= anchor!.start &&
        /^[\s,]*(?:eller|el\.|or)[\s,]*$/i.test(
          page.text.slice(o.end, occs.find((p) => p.start >= o.end && p.start <= anchor!.start)!.start),
        ),
    );
    if (shared) return tok.index;
  }
  return -1;
}

const WHOLE_PAGE_TAGS = new Set(["#root", "html", "body", "main"]);

/**
 * The single NOK price in the name's own product block (the largest element
 * around an occurrence of `key` that names no other product, never the whole
 * page), within PRICE_NAME_MAX_DISTANCE of the name; null when there is none
 * or more than one value. Returns the value, its index and its line. PURE.
 */
export function ownBlockPrice(
  page: PageBlocks,
  occs: NameOccurrence[],
  key: string,
): { value: number; index: number; line: string } | null {
  for (const occ of occs) {
    if (occ.key !== key) continue;
    let card = -1;
    for (let n = nodeAt(page, occ.start); n >= 0; n = page.nodes[n]!.parent) {
      const node = page.nodes[n]!;
      if (WHOLE_PAGE_TAGS.has(node.tag)) break;
      const names = occs.filter((o) => o.start >= node.start && o.start < node.end);
      if (names.some((o) => o.key !== key)) break;
      card = n;
    }
    if (card < 0) continue;
    const node = page.nodes[card]!;
    const found: Array<{ value: number; index: number; line: string }> = [];
    const lines = page.text.slice(node.start, node.end).split("\n");
    let offset = node.start;
    for (const line of lines) {
      for (const v of nokPriceValues(line)) {
        const tok = numberTokensInText(line).find((t) => roundNok(t.value) === roundNok(v));
        if (!tok) continue;
        const index = offset + tok.index;
        if (occs.some((o) => index >= o.start && index < o.end)) continue;
        if (Math.abs(index - occ.start) > PRICE_NAME_MAX_DISTANCE && Math.abs(index - occ.end) > PRICE_NAME_MAX_DISTANCE) continue;
        found.push({ value: roundNok(v), index, line: line.trim() });
      }
      offset += line.length + 1;
    }
    const values = new Set(found.map((f) => f.value));
    if (values.size === 1) return found[0]!;
  }
  return null;
}

/** Same as the other `<meta …>` readers: attribute order does not matter. */
function metaContent(html: string, prop: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]{0,2000}>/gi)) {
    const tag = m[0];
    const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!name || name.toLowerCase() !== prop) continue;
    out.push((tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").trim().toLowerCase());
  }
  return out;
}

/** JSON-LD types that by themselves say «this page is a post». */
const POST_LD_TYPES = ["BlogPosting", "NewsArticle"];

/** The bodies of the page's ld+json scripts. Linear scan (no backtracking on unclosed input). */
function ldJsonBodies(html: string): string[] {
  const out: string[] = [];
  const lower = html.toLowerCase();
  let from = 0;
  for (;;) {
    const open = lower.indexOf("<script", from);
    if (open < 0) break;
    const gt = lower.indexOf(">", open);
    if (gt < 0 || gt - open > 2000) {
      from = open + 7;
      continue;
    }
    const close = lower.indexOf("</script", gt);
    if (close < 0) break;
    if (/type\s*=\s*["']?application\/ld\+json/.test(lower.slice(open, gt))) out.push(html.slice(gt + 1, close));
    from = close + 8;
  }
  return out;
}

/**
 * True when the page is a blog post, so its prices may be old. A POST
 * signal is required: a date in the URL path (/2022/06/…), BlogPosting /
 * NewsArticle JSON-LD, or WordPress post classes (`type-post`,
 * `single-post`) together with a publish date (itemprop datePublished,
 * <time class="published|entry-date|post-date">, article:published_time,
 * an Article JSON-LD node). `article:published_time`, og:type=article or a
 * Yoast @graph `Article` alone are not enough: SEO plugins emit them on
 * ordinary shop pages. PURE; linear on adversarial input.
 */
export function isBlogPostPage(url: string, html: string): boolean {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    /* not a URL: markup only */
  }
  if (/\/(?:19|20)\d{2}\/(?:0?[1-9]|1[0-2])(?:\/|$)/.test(path)) return true;
  const h = html || "";
  let articleNode = false;
  for (const body of ldJsonBodies(h)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const nodes: any[] = [];
    collectNodes(parsed, nodes);
    if (nodes.some((node) => POST_LD_TYPES.some((t) => hasType(node, t)))) return true;
    if (nodes.some((node) => hasType(node, "Article"))) articleNode = true;
  }
  const postClass = /\bclass\s*=\s*["'][^"'>]{0,1000}\b(?:type-post|single-post)\b/i.test(h);
  if (!postClass) return false;
  let timePublished = false;
  for (const m of h.matchAll(/<time\b[^>]{0,500}>/gi)) {
    if (/\bclass\s*=\s*["'][^"']{0,500}\b(?:published|entry-date|post-date)\b/i.test(m[0])) {
      timePublished = true;
      break;
    }
  }
  return (
    timePublished ||
    articleNode ||
    /\bitemprop\s*=\s*["']datePublished["']/i.test(h) ||
    metaContent(h, "article:published_time").some((v) => v !== "")
  );
}

export interface AnchorPage {
  url: string;
  html: string;
}

/**
 * Fixes 1–4 on the LLM tier's grounded candidates, against the pages the
 * model's text came from (product pages first, homepage last). Mutates the
 * candidates: a price not at its name → dropped (price_not_at_name); a price
 * only on a blog post → dropped (price_blog_source_dropped); a price marked
 * «ekskl. mva.» at the price or page-wide → price_excl_vat. Sets
 * `source_url` to the page the price was read on, else the first non-blog
 * page with the name. PURE apart from the mutation.
 */
export function anchorLlmCandidates(items: ProductCandidate[], pages: AnchorPage[]): void {
  if (pages.length === 0) return;
  const names = items.map((c) => c.name);
  const parsed = pages.map((p) => {
    const blocks = parsePageBlocks(p.html);
    return {
      url: p.url,
      blocks,
      occs: findNameOccurrences(blocks.text, names),
      blog: isBlogPostPage(p.url, p.html),
      pageExclVat: statesPagePricesExclVat(blocks.text),
    };
  });
  const ordered = [...parsed.filter((p) => !p.blog), ...parsed.filter((p) => p.blog)];
  for (const c of items) {
    const key = productNameKey(c.name);
    const named = ordered.filter((p) => p.occs.some((o) => o.key === key));
    const fallbackUrl = named[0]?.url ?? c.source_url ?? pages[0]!.url;
    if (c.price_nok === null) {
      c.source_url = fallbackUrl;
      continue;
    }
    let hit: { page: (typeof parsed)[number]; index: number } | null = null;
    for (const p of named) {
      const index = findPriceAtName(p.blocks, p.occs, key, c.price_nok);
      if (index >= 0) {
        hit = { page: p, index };
        break;
      }
    }
    if (!hit) {
      // The name's own card shows one price: that one, verbatim (fix 1).
      let own: { page: (typeof parsed)[number]; found: NonNullable<ReturnType<typeof ownBlockPrice>> } | null = null;
      for (const p of named) {
        if (p.blog) continue;
        const found = ownBlockPrice(p.blocks, p.occs, key);
        if (found) {
          own = { page: p, found };
          break;
        }
      }
      if (!own) {
        dropPrice(c, "price_not_at_name");
        c.source_url = fallbackUrl;
        continue;
      }
      const parsedLine = parseNokPrice(own.found.line);
      const unit = parsedLine.unit;
      c.price_nok = own.found.value;
      c.price_text = own.found.line.slice(0, 80);
      c.price_is_from = parsedLine.price_is_from;
      c.unit = unit === "kg" || unit === "g" || unit === "l" ? (statesUnitPrice(own.found.line, unit) ? unit : null) : unit;
      c.pack_size = null;
      c.rules = c.rules.filter((r) => r !== "unit_pack_weight" && r !== "unit_unstated_dropped" && r !== "price_multiple_lowest");
      if (!c.rules.includes("price_reanchored")) c.rules.push("price_reanchored");
      hit = { page: own.page, index: own.found.index };
    }
    if (hit.page.blog) {
      dropPrice(c, "price_blog_source_dropped");
      c.source_url = fallbackUrl;
      continue;
    }
    c.source_url = hit.page.url;
    const text = hit.page.blocks.text;
    const nl = text.indexOf("\n", hit.index);
    const after = text.slice(hit.index, Math.min(nl === -1 ? text.length : nl, hit.index + 40));
    if (statesExclVat(c.raw_price_text) || statesExclVat(after) || hit.page.pageExclVat) markExclVat(c);
  }
}
