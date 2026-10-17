/**
 * A small fake DOM for running a page's own inline script in node:vm: an
 * element's innerHTML reads back what the page set the way a browser
 * serializes it (text nodes and attribute values escaped), and fetch, timers
 * and document events are driven by the test.
 *
 * dev-request 2026-10-17-integrasjonstest-oppfolging: moved here from
 * src/routes/rfb-escaping-kort-forslag-admin-selger.test.ts (I-K) so the card
 * grid, suggestions, admin alert and seller match list (I-K) and the seller
 * stats tab, trust breakdown, alerts, admin login alert and modal months
 * (I-M) run the pages the same way. Unchanged in the move.
 */

import * as vm from "vm";
import { decode } from "./html-injection";

/** Text as the HTML serializer writes a text node. */
export function serializeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/\u00a0/g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** An attribute value as the HTML serializer writes it. */
function serializeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/\u00a0/g, "&nbsp;").replace(/"/g, "&quot;");
}

type Listener = (this: FakeElement, event: unknown) => unknown;

/** A text node: serialized as text. */
export class FakeText {
  constructor(readonly data: string) {}
  get outerHTML(): string { return serializeText(this.data); }
}

/**
 * An element whose content is raw HTML (set through innerHTML), serialized
 * text (set through textContent) or appended elements; innerHTML reads it
 * back the way a browser serializes it.
 */
export class FakeElement {
  id = "";
  className = "";
  value = "";
  type = "";
  src = "";
  checked = false;
  disabled = false;
  onload: unknown = null;
  style: Record<string, string> = {};
  readonly classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  private parts: Array<string | FakeElement | FakeText> = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly tagName: string) {}

  get innerHTML(): string {
    return this.parts.map((p) => (typeof p === "string" ? p : p.outerHTML)).join("");
  }
  set innerHTML(html: string) {
    this.parts = [String(html)];
  }
  get textContent(): string {
    return decode(this.innerHTML.replace(/<[^>]*>/g, ""));
  }
  set textContent(text: unknown) {
    this.parts = [serializeText(text == null ? "" : String(text))];
  }
  get outerHTML(): string {
    const attrs = (this.className ? ` class="${serializeAttr(this.className)}"` : "") +
      [...this.attributes].map(([n, v]) => ` ${n}="${serializeAttr(v)}"`).join("");
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
  get children(): FakeElement[] {
    return this.parts.filter((p): p is FakeElement => p instanceof FakeElement);
  }
  appendChild<T>(child: T): T {
    this.parts.push(child as unknown as FakeElement);
    return child;
  }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  /** Calls the listeners of `type` the way the browser does (this = the element). */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn.call(this, { type, target: this, preventDefault() {}, ...event });
  }
  click(): void { this.dispatch("click"); }
  querySelector(): FakeElement | null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  closest(): FakeElement | null { return null; }
  remove(): void {}
  focus(): void {}
  scrollIntoView(): void {}
}

export type FetchStub = (url: string, opts?: { method?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface Page {
  context: any;
  el(id: string): FakeElement;
  /** Fires a document event (DOMContentLoaded runs the page's own start-up). */
  fireDocument(type: string): void;
  /** Runs the queued timers with a delay up to `maxDelay` ms. */
  runTimers(maxDelay: number): void;
}

export function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

/** Runs a page's inline script with the fake DOM; `fetch` answers its requests. */
export function runPage(script: string, fetchStub: FetchStub, location: { pathname: string; search?: string }): Page {
  const elements = new Map<string, FakeElement>();
  const el = (id: string) => {
    if (!elements.has(id)) {
      const e = new FakeElement("div");
      e.id = id;
      elements.set(id, e);
    }
    return elements.get(id)!;
  };
  const docListeners = new Map<string, Array<() => void>>();
  let timers: Array<{ fn: () => void; delay: number }> = [];
  const document = {
    readyState: "complete", title: "",
    getElementById: el,
    querySelector: () => new FakeElement("div"), querySelectorAll: () => [],
    createElement: (tag: string) => new FakeElement(String(tag).toLowerCase()),
    createTextNode: (text: unknown) => new FakeText(String(text)),
    addEventListener: (type: string, fn: () => void) => { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]); },
    body: new FakeElement("body"), head: new FakeElement("head"),
  };
  const search = location.search ?? "";
  const context: Record<string, unknown> = {
    document, fetch: fetchStub, URLSearchParams,
    location: { pathname: location.pathname, search, href: `https://rettfrabonden.com${location.pathname}${search}`, hostname: "rettfrabonden.com", origin: "https://rettfrabonden.com" },
    navigator: {}, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn: () => void, delay?: number) => { timers.push({ fn, delay: delay ?? 0 }); return timers.length; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, open() {}, alert() {}, confirm: () => true,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context);
  return {
    context,
    el,
    fireDocument: (type) => { for (const fn of docListeners.get(type) ?? []) fn(); },
    runTimers: (maxDelay) => {
      const due = timers.filter((t) => t.delay <= maxDelay);
      timers = timers.filter((t) => t.delay > maxDelay);
      for (const t of due) t.fn();
    },
  };
}
