# opplevagent-mcp

MCP server for [opplevagent.no](https://opplevagent.no) — find Norwegian experiences and activities from Claude Desktop, ChatGPT, Cursor, and other AI assistants.

Curated, Brreg-verified experiences searchable by county, category, weather, season, group size, price, and duration.

## Install

```bash
npx opplevagent-mcp
```

Or add to Claude Desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "opplevagent": {
      "command": "npx",
      "args": ["opplevagent-mcp"]
    }
  }
}
```

## Remote (Streamable HTTP)

For ChatGPT and other remote MCP clients, paste this URL directly:

```
https://opplevagent.no/mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `discover_experiences` | Search experiences by county (fylke), category, weather, season, indoor/outdoor, group size, age, price, duration |
| `list_experience_categories` | List all categories with experience counts |
| `get_experience` | Full details for one experience via UUID |

## Examples

```
hva kan vi finne på i Troms om vinteren?
utendørsaktiviteter i Oslo for 4 personer
opplevelser som passer i regnvær i Bergen
hvalsafari Tromsø
familievennlige aktiviteter under 500 kr
hvilke typer opplevelser finnes i Norge?
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `OPPLEVAGENT_URL` | `https://opplevagent.no` | Override API base URL |

## License

MIT
