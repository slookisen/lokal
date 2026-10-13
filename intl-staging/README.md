# rfb-intl-staging

Standalone Fly.io service that holds the **Swedish (later Danish) candidate base**: register units, candidates, draft
profiles, page excerpts and LLM-judge verdicts. It is a **separate app with its own volume**, so batch runs never put
load on the prod `lokal` app (DPIA T17: the candidate base lies outside prod). Nothing here is shown anywhere: every
route except `GET /health` needs the bearer token, responses carry `X-Robots-Tag: noindex`, and there is no list-all
export.

Background: A2A `dev-requests/2026-10-13-se-batch-profiler-staging.md` (Daniel live 2026-10-13) and the phase-1 legal
drafts in A2A `strategic-decisions/se-dk-fase1/` (LIA SE, DPIA).

## What it does

- **Register import** (`POST /import/se`, no LLM): streams the official SCB and Bolagsverket bulk files, keeps only
  active legal persons (AB, HB/KB, ekonomisk förening) in SNI 01/03/10/11, and turns those whose activity description
  carries a direct-sale keyword into candidates. Sole traders and personnummer are dropped in memory and never stored.
  Västra Götaland first, then Skåne, then the rest.
- **Build queue**: a batch run leases candidates, researches each one, and submits a draft with a source URL and a
  quote for every field. The server refuses fields outside the whitelist, quotes that are not in the stored page
  excerpt, social media or people-search sources, personnummer, contact details not published on the producer's own
  site, a visiting address without two sources, and Norwegian/Danish letters in Swedish text.
- **Judge queue**: a separate judge run (a different `run_id` from the builder) leases drafts with their excerpts and
  posts `approve`, `reject` or `needs_review`. An `approve` that contradicts its own checks is refused.
- **Brakes**: the line pauses itself when more than 10 % of the last ≥ 20 verdicts found the wrong entity, or when
  the volume is ≥ 80 % full or the database exceeds 2 GB (`507`). Page excerpts are deleted after 30 days.

## First-time setup (Daniel, from a machine with `flyctl`)

```bash
cd intl-staging
fly apps create rfb-intl-staging
fly volumes create intl_data --app rfb-intl-staging --region arn --size 3 --yes
TOKEN=$(openssl rand -hex 32)
fly secrets set --app rfb-intl-staging --stage INTL_STAGING_TOKEN="$TOKEN" INTL_STAGING_HMAC_KEY="$(openssl rand -hex 32)"
fly deploy
curl https://rfb-intl-staging.fly.dev/health
echo "$TOKEN"   # copy it into the Claude environment (next step), then clear your terminal
```

Then, in the Claude cloud environment the batch routine runs in, add a **network secret** for host
`rfb-intl-staging.fly.dev` with header `Authorization: Bearer <TOKEN>`. The routine never sees the token; the proxy adds
it. Later deploys: `cd intl-staging && fly deploy`.

The machine uses `auto_stop_machines = "suspend"`, so it sleeps when nobody calls it and costs only the volume.

## API (all JSON, all need the token except /health)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, pause flag, disk %, DB size |
| GET | `/stats` | counts per status and county, build outcomes, judge quality window, last import |
| POST | `/import/se` · GET `/import/status` | run the register import (poll status every minute; the polling also keeps the machine awake) |
| POST | `/candidates/lease` | `{run_id, n≤25, county?}` → candidates with register data |
| GET | `/register/search?name=&town=` | match a producer found by web search to a register unit |
| POST | `/candidates/from-search` | `{run_id, org_nr}` → adds and leases an in-scope unit |
| POST | `/candidates/:id/draft` | `{run_id, outcome, fields?, excerpts?}` |
| POST | `/judge/lease` | `{run_id, n≤25}` → drafts from other runs, with excerpts |
| POST | `/drafts/:id/verdict` | `{run_id, verdict, entity_match, direct_sale_ok, language_ok, personal_data_found, field_results, reasons}` |
| GET | `/sample?n=10` | random approved profiles for a human spot check |
| POST | `/pause` · `/resume` · `/purge` · `/optout` | operations |

## Local development

```bash
cd intl-staging
npm install
npm test          # node:test via tsx
INTL_STAGING_TOKEN=dev DATA_DIR=./data npm run dev
```

## Rollback

`POST /pause`, or `fly scale count 0 --app rfb-intl-staging`. To remove everything: `fly apps destroy rfb-intl-staging`
(deletes the volume and all data). Prod is not involved.
