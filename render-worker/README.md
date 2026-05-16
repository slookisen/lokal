# lokal-render-worker

Standalone Fly.io service that renders JavaScript-heavy pages with headless
Chromium (via Playwright) and returns the resulting HTML. The main `lokal`
app (and future scrapers) call this when a target site is a SPA whose
content is invisible to plain `fetch`/`curl` — e.g. `hanen.no/medlemmer`,
`norskgardsmat.no`, etc.

## Local dev

```bash
cd render-worker
npm install
RENDER_KEY=dev npm run dev
curl localhost:8080/health
```

Test render call:

```bash
curl -X POST localhost:8080/render \
  -H "X-Render-Key: dev" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hanen.no/medlemmer"}'
```

## Endpoints

- `GET /health` — `{status, uptime, browser_ready}`. Used by Fly healthcheck.
- `POST /render` — requires `X-Render-Key` header. Body:
  `{ url, wait_for?, timeout_ms?, wait_selector? }`. Returns
  `{ status, url, status_code, content_type, html, html_bytes, duration_ms, timestamp }`.

Status codes: `400` invalid body, `401` bad key, `502` navigation failed,
`504` timeout, `500` internal.

## Deploy

```bash
fly deploy --config render-worker/fly.toml --dockerfile render-worker/Dockerfile
fly secrets set RENDER_KEY=<generated-key> --app lokal-render-worker
```

The app is named `lokal-render-worker`, runs in `arn` (Stockholm), and uses
`auto_stop_machines = "suspend"` with `min_machines_running = 0` so it cold-
starts when called and idles to zero cost when not.

## How it's used

The main `lokal` app calls this from `src/services/render-client.ts` (added
in this PR) when scraping JS-rendered pages. Future PRs (PR-56 BM events
fallback, Hanen umbrella-member scraper) will use that wrapper instead of
plain `fetch` whenever a target is a SPA.
