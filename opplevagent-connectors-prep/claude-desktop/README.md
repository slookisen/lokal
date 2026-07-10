# Opplevagent — Claude Desktop connector submission checklist

## What's ready

- **Remote MCP endpoint (streamable-http):** `https://opplevagent.no/mcp`
- **Local stdio install:** `npx opplevagent-mcp` (npm package `opplevagent-mcp@0.1.0`, verified
  via `mcp-server-opplevagent/package.json` and `index.js` in this repo)
- **DXT manifest:** `manifest.json` in this directory (`manifest_version` 0.3)
- **MCP registry server descriptor:** `server.json` in this directory
  (`io.github.slookisen/opplevagent-mcp`)
- **Icon:** `https://opplevagent.no/favicon-192.png` (192×192 PNG)
- **Policy URLs:**
  - Privacy: `https://opplevagent.no/personvern`
  - Terms: `https://opplevagent.no/vilkar`
- **Contact:** `da.fredriksen@gmail.com`
- **Auth:** none — public, read-only

**Tools:** `discover_experiences`, `list_experience_categories`, `get_experience`

## Note on source-of-truth correction

The original task brief for this prep packet assumed opplevagent-mcp lives in a separate
`github.com/slookisen/opplevagent-mcp` repo. That is **not** what this checked-out repo shows:
`mcp-server-opplevagent/package.json` and `mcp-server-opplevagent/server.json` both declare the
repository as `https://github.com/slookisen/lokal.git`, subfolder `mcp-server-opplevagent` — i.e.
opplevagent-mcp is published from a subfolder of the same `lokal` monorepo, exactly parallel to
how `lokal-mcp` is published from `mcp-server/`. `manifest.json` and `server.json` in this
directory use the **verified** repository URL (`slookisen/lokal.git`) and issues URL
(`github.com/slookisen/lokal/issues`), not the assumed separate-repo one. See the `_source_note`
field in `manifest.json` for the inline flag.

No other judgement calls were needed: local stdio launch mechanics (`entry_point: index.js`,
`node ${__dirname}/index.js`), the npm package identifier, the optional `OPPLEVAGENT_URL` env var,
and the `MIT` license are all directly verified against `mcp-server-opplevagent/index.js`,
`package.json`, and `server.json` in this repo — none of it is inferred or guessed.

## Manual submission steps

1. Open Claude Desktop → **Settings → Connectors → Add custom connector**.
2. Paste the remote MCP URL: `https://opplevagent.no/mcp` (streamable-http, no auth).
   - Alternatively, for local/stdio install, use the config block from
     `mcp-server-opplevagent/README.md`:
     ```json
     {"mcpServers":{"opplevagent":{"command":"npx","args":["opplevagent-mcp"]}}}
     ```
3. If submitting to the public Claude Desktop connector directory rather than adding a personal
   connector, follow the directory's submission form using `manifest.json` / `server.json` in this
   directory as the source data (name, description, icon, tools, policy URLs, contact).
4. Upload the icon (`https://opplevagent.no/favicon-192.png`) and confirm the privacy/terms links
   resolve before submitting.

## Testing before submit

Connect Claude Desktop to `https://opplevagent.no/mcp` (or the local `npx opplevagent-mcp`
config) and ask:
- "Hva kan vi finne på i Troms om vinteren?" (exercises `discover_experiences`)
- "Hvilke kategorier med opplevelser finnes?" (exercises `list_experience_categories`)
- "Vis full info om [id fra discover-resultat]" (exercises `get_experience`)

Verify the tool calls return real data (or a graceful "ingen data" message if the experiences DB
isn't populated) and that booking URLs in `get_experience` results resolve correctly.
