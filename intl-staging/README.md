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
  carries a direct-sale keyword into candidates (main industry only). Sole traders and personnummer are dropped in
  memory and never stored; an HB/KB (whose name is often the partners' own) is stored only when it is a candidate.
  Västra Götaland first, then Skåne, then the rest.
- **Build queue**: a batch run leases candidates, researches each one, and submits a draft with a source URL and a
  quote for every field. The server refuses fields outside the whitelist, quotes that are not in the stored page
  excerpt or not bound to the value, any source other than the producer's own website (named exceptions:
  OpenStreetMap for the name and address, krav.se for KRAV), a directory page posing as the website, personnummer in
  any formatting, a visiting address without two sources, and Norwegian/Danish letters in Swedish text. Personnummer
  in page excerpts are redacted before storage.
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

**First import — run it by hand once.** The register import takes about 5 minutes on a fast machine (measured
2026-10-13: 1.8 M SCB rows + 3.0 M Bolagsverket records, 164 MB RSS) and longer on a throttled `shared-cpu-1x`. A
suspended machine drops the download, so keep traffic going while it runs:

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" https://rfb-intl-staging.fly.dev/import/se
while sleep 60; do curl -sS -H "Authorization: Bearer $TOKEN" https://rfb-intl-staging.fly.dev/import/status | head -c 300; echo; done
```

Stop the loop when `state` is `done` (or `failed` — then run it again). Later weekly re-imports are done by the routine.

**Data lifetime.** Page excerpts are deleted 30 days after they were fetched (on a timer, and on the first requests
after the machine wakes). Fly keeps daily volume snapshots for about 5 days, so deleted data can live that long in a
snapshot. Register units that leave the register are marked inactive; rejected drafts and verdicts are kept as an
audit trail until a retention rule is decided.

**Merging the PR that changes this folder redeploys prod** with unchanged code (the main `fly-deploy.yml` has no path
filter). That is an ordinary restart of `lokal`.

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
| POST | `/drafts/:id/verdict` | `{run_id, verdict, entity_match, direct_sale_ok, language_ok, personal_data_found, excerpt_verified?, field_results, reasons}` |
| GET | `/sample?n=10` | random approved profiles for a human spot check |
| POST | `/pause` · `/resume` · `/purge` · `/optout` | operations (`/resume` also restarts the quality window, whatever the pause reason) |

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
