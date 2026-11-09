/**
 * sw-test-harness.ts — runs a service-worker source file (src/public/sw.js or
 * src/public/opplevagent-sw.js) inside a vm sandbox with fake `self`,
 * `caches` and `fetch`, so tests can dispatch fetch events through the REAL
 * fetch handler and observe what it intercepts and what it writes to the
 * cache. Shared by sw.test.ts and opplevagent-sw.test.ts.
 */

import vm from "vm";

export interface SimResult {
  /** true when the handler called event.respondWith(...) */
  intercepted: boolean;
  /** the response the handler resolved with (when intercepted) */
  response: Response | null;
}

export interface SwSim {
  dispatch(req: { url: string; method?: string; mode?: string }): Promise<SimResult>;
  /** URLs written with cache.put(...), in order */
  puts: string[];
  /** URLs passed to the fake network fetch(...), in order */
  networkFetches: string[];
}

/**
 * `respond(url)` builds the fake network's response for a URL. Default:
 * 200 with no Cache-Control header.
 */
export function createSwSim(swSrc: string, origin: string, respond?: (url: string) => Response): SwSim {
  const listeners: Record<string, (event: any) => void> = {};
  const store = new Map<string, Response>();
  const puts: string[] = [];
  const networkFetches: string[] = [];
  const keyOf = (req: any) => (typeof req === "string" ? new URL(req, origin).href : req.url);

  const cache = {
    put: async (req: any, res: Response) => {
      puts.push(keyOf(req));
      store.set(keyOf(req), res);
    },
    addAll: async () => {},
  };
  const caches = {
    open: async () => cache,
    match: async (req: any) => store.get(keyOf(req)),
    keys: async () => [],
    delete: async () => true,
  };
  const self = {
    addEventListener: (type: string, fn: (event: any) => void) => {
      listeners[type] = fn;
    },
    location: { origin },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const fakeFetch = async (req: any) => {
    const url = keyOf(req);
    networkFetches.push(url);
    return respond ? respond(url) : new Response("body", { status: 200 });
  };

  vm.runInNewContext(swSrc, { self, caches, fetch: fakeFetch, URL, Response, console });

  return {
    puts,
    networkFetches,
    async dispatch(req) {
      const request = { url: req.url, method: req.method || "GET", mode: req.mode || "no-cors" };
      let pending: Promise<Response> | null = null;
      listeners.fetch({
        request,
        respondWith: (p: Promise<Response>) => {
          pending = Promise.resolve(p);
        },
      });
      let response: Response | null = null;
      if (pending) response = await pending;
      // let the fire-and-forget caches.open(...).then(cache.put) chain settle
      await new Promise((r) => setImmediate(r));
      return { intercepted: pending !== null, response };
    },
  };
}
