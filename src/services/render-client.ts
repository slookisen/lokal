// ─── Render Client ─────────────────────────────────────────
// Tiny wrapper for calling the standalone `lokal-render-worker`
// Fly app (see render-worker/ at the repo root) to fetch fully
// JS-rendered HTML for SPA targets like hanen.no/medlemmer.
//
// No routes call this yet — it's a library function ready for
// PR-56 (BM events fallback) and future Hanen scraping.

const WORKER_URL =
  process.env.RENDER_WORKER_URL || "https://lokal-render-worker.fly.dev";
const WORKER_KEY = process.env.RENDER_WORKER_KEY || "";

export interface RenderOptions {
  timeout_ms?: number;
  wait_selector?: string;
  wait_for?: "load" | "domcontentloaded" | "networkidle";
  /**
   * UA override forwarded to the worker's `/render` request body. Omitting
   * it (or leaving it undefined) means the worker uses its own default
   * `USER_AGENT` constant — unchanged behaviour. `opts` is spread directly
   * into the JSON body below, so this field needs no extra wiring here: it
   * rides along with `timeout_ms`/`wait_for`/`wait_selector` automatically.
   */
  user_agent?: string;
}

export interface RenderResult {
  html: string;
  status_code: number;
  duration_ms: number;
  source: "render-worker";
  /** Post-redirect URL the worker actually landed on (its `page.url()`). */
  final_url: string;
}

export async function renderPage(
  url: string,
  opts?: RenderOptions
): Promise<RenderResult> {
  if (!WORKER_KEY) {
    throw new Error(
      "RENDER_WORKER_KEY env var not set; cannot call render-worker"
    );
  }

  const timeoutMs = opts?.timeout_ms ?? 30000;

  const res = await fetch(`${WORKER_URL}/render`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Render-Key": WORKER_KEY,
    },
    body: JSON.stringify({ url, ...opts }),
    // worker timeout + 5s slack so the worker's own timeout response
    // arrives before our fetch aborts.
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`render-worker ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    html: string;
    status_code: number;
    duration_ms: number;
    url: string;
  };

  return {
    html: data.html,
    status_code: data.status_code,
    duration_ms: data.duration_ms,
    source: "render-worker",
    final_url: data.url,
  };
}
