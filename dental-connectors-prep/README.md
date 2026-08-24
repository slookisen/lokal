# Finn tannlege — connectors submission prep

Paste-ready submission package for the **Anthropic connectors directory**
(`claude.ai/admin-settings/directory/submissions/new`) for the remote MCP server at
`https://finn-tannlege.com/mcp`.

Same shape as `opplevagent-connectors-prep/` and `rfb-connectors-prep/`. Filed from
dev-request `A2A/dev-requests/2026-08-24-claude-connector-pakker-rfb-dental.md`; runbook
context in `A2A/protocols/chatgpt-apps-submission-handoff-2026-08-24.md` §C.

## ⚠️ One hard blocker before this can be submitted

**`https://finn-tannlege.com/vilkar` returns 404.** The directory requires both a privacy
policy URL and a terms-of-service URL. Privacy is fine
(`https://finn-tannlege.com/personvern`, 200); terms does not exist on this domain in any
spelling checked live 2026-08-24 — `/vilkar`, `/vilkaar`, `/terms` and `/bruksvilkar` all
404. The sibling domains both serve `/vilkar` at 200, so this is a per-domain gap, not a
platform-wide one.

Nothing in this package guesses around it. Everything else here is complete and correct;
the terms page has to be published before the submission form can be completed. Raised as
a finding in the dev-request's `FUNN TIL OPPFØLGING` block.

## Contents

| File | What it is |
|---|---|
| `claude-directory/portal-answers.md` | Every portal step, answered. Copy → paste. |
| `claude-directory/listing.md` | Listing name / tagline / description with character counts. |
| `claude-directory/test-instructions.md` | Reviewer test instructions + prompts (open server, no account). |

No `assets/` directory: unlike RFB, no square PNG icon exists for this vertical yet — see
"Known gaps" below.

## Verified live 2026-08-24 (not copied from older documents)

Every fact below was re-read from the live endpoint on the date above by the
platform-orchestrator wake that built this package
(`run-2026-08-24T183542-ba2c70-platform-orchestrator-rfb`).

- **MCP endpoint:** `https://finn-tannlege.com/mcp` — streamable-http, no authentication.
  `initialize` handshake required before `tools/list`.
- **Tools: 5, all read-only, none destructive**, every one carrying `title` +
  `readOnlyHint` + `destructiveHint` (the directory's hard requirement — already
  satisfied). Full table in `claude-directory/portal-answers.md`.
- **Clinic count: 6 961** (live `tannlege_stats`, 2026-08-24). Of those: 782 with a Helfo
  direct-billing agreement, 732 with emergency duty (akuttvakt), 1015 with at least one
  registered specialist. Two rows in the county breakdown are housekeeping, not clinics:
  `Ukjent` (27) and `TEST` (1).
- **Policy URLs:**
  - Privacy: `https://finn-tannlege.com/personvern` — **200**
  - Terms: `https://finn-tannlege.com/vilkar` — **404, see blocker above**
- **Documentation URL:** `https://finn-tannlege.com/llms.txt` (200) — also the
  `documentation` field in `https://finn-tannlege.com/.well-known/mcp.json`.
- **Icon:** only `https://finn-tannlege.com/favicon.svg` (200, SVG). `favicon-192.png`
  404s. No square PNG exists for this vertical in either repo.
- **npm stdio package:** `finn-tannlege-mcp@0.1.0`
  (`mcp-server-dental/package.json`, published from the `lokal` monorepo).

## Known gaps — state these, do not paper over them

1. **Terms of service page missing** (blocker, above).
2. **No square PNG icon.** The directory wants a square raster icon; this domain serves
   only an SVG favicon. One needs producing, the same way
   `opplevagent-connectors-prep/assets/` and `rfb-connectors-prep/assets/` already have
   one. Related: dev-request `2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering`.
3. **`tannlege_kjeder` currently returns an empty world.** The tool works, but live
   `tannlege_stats` reports `chain_count: 0` — no clinic is presently tagged as belonging
   to a chain. The tool is real and correctly annotated; it just has no data behind it
   today. Do not write listing copy that promises chain comparison as a headline feature.

## Not in this package

- The submission itself — needs a Claude **Team/Enterprise org** with Owner role, which
  Daniel does not have today (runbook §C), *and* the terms page above. Parked, not
  blocked: the same texts work verbatim as **custom-connector user documentation** (a Pro
  user can add `https://finn-tannlege.com/mcp` manually).
- UI cards. finn-tannlege is a tools-only server; that is a valid directory listing, and
  the MCP Apps screenshot requirement does not apply to it.
