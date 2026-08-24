# Rett fra Bonden — connectors submission prep

Paste-ready submission package for the **Anthropic connectors directory**
(`claude.ai/admin-settings/directory/submissions/new`) for the remote MCP server at
`https://rettfrabonden.com/mcp`.

Same shape as `opplevagent-connectors-prep/`. Filed from dev-request
`A2A/dev-requests/2026-08-24-claude-connector-pakker-rfb-dental.md`; runbook context in
`A2A/protocols/chatgpt-apps-submission-handoff-2026-08-24.md` §C.

## Contents

| File | What it is |
|---|---|
| `claude-directory/portal-answers.md` | Every portal step, answered. Copy → paste. |
| `claude-directory/listing.md` | Listing name / tagline / description with character counts. |
| `claude-directory/test-instructions.md` | Reviewer test instructions + prompts (open server, no account). |
| `assets/rfb-square-512.png` | Square 512×512 PNG icon, full-bleed, no rounded corners. |

## Verified live 2026-08-24 (not copied from older documents)

Every fact below was re-read from the live endpoint on the date above by the
platform-orchestrator wake that built this package
(`run-2026-08-24T183542-ba2c70-platform-orchestrator-rfb`).

- **MCP endpoint:** `https://rettfrabonden.com/mcp` — streamable-http, no authentication.
  `initialize` handshake required before `tools/list` (a client that skips it gets
  `Bad Request: Server not initialized`).
- **Tools: 14**, every one carrying `title` + `readOnlyHint` + `destructiveHint`
  (the directory's hard requirement — already satisfied, no code fix pending).
  **11 read-only, 3 write, 0 destructive.** Full table in `claude-directory/portal-answers.md`.
- **Policy URLs, both HTTP 200:**
  - Privacy: `https://rettfrabonden.com/personvern`
  - Terms: `https://rettfrabonden.com/vilkar`
- **Documentation URL:** `https://rettfrabonden.com/teknologi` (200) — also the
  `documentation` field in `https://rettfrabonden.com/.well-known/mcp.json`.
  Machine-readable overview: `https://rettfrabonden.com/llms.txt` (200).
- **Icon:** `assets/rfb-square-512.png` (512×512, square, no rounded corners — clients
  crop circularly themselves). `https://rettfrabonden.com/favicon.svg` is 200 but SVG-only;
  `favicon-192.png` still 404s (tracked in dev-request
  `2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering`), so the icon is supplied as a file
  upload, not a URL.
- **Producer count:** use the form **«over 1 600»** / "more than 1,600". Deliberate: the
  platform's own three counters disagree and each is honest about a different thing —
  `llms.txt` says 1631 registered producers, `/health` reports `agents: 1712` /
  `totalAgents: 1764`, and `.well-known/mcp.json` says 1764. None of them is wrong; they
  count different sets. Do not paste a precise figure into a permanent listing.

## Not in this package

- The submission itself — needs a Claude **Team/Enterprise org** with Owner role, which
  Daniel does not have today (runbook §C). Parked, not blocked: the same texts work
  verbatim as **custom-connector user documentation** (a Pro user can add
  `https://rettfrabonden.com/mcp` manually), and are ready the day the org exists.
- UI cards (`ui://…` resources). RFB is a tools-only server today; that is a valid
  directory listing. Cards can be added later.
- MCP Apps carousel screenshots — those are an opplevagent-only requirement
  (dev-request `2026-08-24-mcp-apps-skjermbilder-opplevagent`), because only opplevagent
  ships UI cards.
- The separate desktop-extension (`.mcpb`) form, which does **not** require an org:
  `mcp-server/lokal-mcp.mcpb` is already built for that path.
