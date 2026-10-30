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
  let text = "";
  const sep = (ch: " " | "\n") => {
    if (!text) return;
    if (text.endsWith("\n")) return;
    if (text.endsWith(" ")) {
      if (ch === "\n") text = text.slice(0, -1) + "\n";
      return;
    }
    text += ch;
  };
  const addText = (raw: string) => {
    let t = decodeHtmlEntities(raw).replace(/[\s ]+/g, " ");
    if (!t.trim()) {
      if (t) sep(" ");
      return;
    }
    if (!text || /\s$/.test(text)) t = t.replace(/^ /, "");
    const start = text.length;
    text += t;
    const lead = t.length - t.trimStart().length;
    const trail = t.length - t.trimEnd().length;
    runs.push({ start: start + lead, end: text.length - trail, node: stack[stack.length - 1]! });
  };
  const closeTo = (idx: number) => {
    while (stack.length - 1 >= idx && stack.length > 1) {
      const id = stack.pop()!;
      nodes[id]!.end = text.length;
    }
  };
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let last = 0;
  for (const m of cleaned.matchAll(tagRe)) {
    addText(cleaned.slice(last, m.index));
    last = m.index! + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    sep(BLOCK_TAGS.has(tag) ? "\n" : " ");
    if (closing) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (nodes[stack[i]!]!.tag === tag) {
          closeTo(i);
          break;
        }
      }
      continue;
    }
    if (VOID_TAGS.has(tag) || m[3] === "/") continue;
    if (SELF_NESTING_CLOSES.has(tag) && stack.length > 1 && nodes[stack[stack.length - 1]!]!.tag === tag) {
      closeTo(stack.length - 1);
    }
    nodes.push({ tag, parent: stack[stack.length - 1]!, start: text.length, end: text.length });
    stack.push(nodes.length - 1);
  }
  addText(cleaned.slice(last));
  closeTo(1);
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
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  return all.filter(
    (o) => !all.some((p) => p !== o && p.key !== o.key && p.start <= o.start && p.end >= o.end && p.end - p.start > o.end - o.start),
  );
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
  for (const tok of numberTokensInText(page.text)) {
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
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!name || name.toLowerCase() !== prop) continue;
    out.push((tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").trim().toLowerCase());
  }
  return out;
}

const BLOG_LD_TYPES = ["BlogPosting", "Article", "NewsArticle"];

/**
 * True when the page is a blog post / article, so its prices may be old:
 * a date in the URL path (/2022/06/…), `article:published_time`,
 * BlogPosting / Article / NewsArticle JSON-LD, or article markup
 * (`<article>` or og:type=article) WITH a publish date. A shop page that
 * only uses `<article>` for product cards has no publish date. PURE.
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
  if (metaContent(h, "article:published_time").some((v) => v !== "")) return true;
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of h.matchAll(re)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const nodes: any[] = [];
    collectNodes(parsed, nodes);
    if (nodes.some((node) => BLOG_LD_TYPES.some((t) => hasType(node, t)))) return true;
  }
  const dated =
    /\bitemprop\s*=\s*["']datePublished["']/i.test(h) ||
    /<time\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:published|entry-date|post-date)\b/i.test(h);
  if (!dated) return false;
  return /<article\b/i.test(h) || metaContent(h, "og:type").includes("article");
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
