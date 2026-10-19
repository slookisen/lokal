# finn-tannlege-mcp

MCP server for [finn-tannlege.com](https://finn-tannlege.com) — find Norwegian dental clinics from Claude Desktop, ChatGPT, Cursor, and other AI assistants.

More than 4,500 clinics, with Helfo agreement, specialty, emergency care and chain data.

## Install

```bash
npx finn-tannlege-mcp
```

Or add to Claude Desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "finn-tannlege": {
      "command": "npx",
      "args": ["finn-tannlege-mcp"]
    }
  }
}
```

## How it works

Since 0.2.0 the package is a thin stdio bridge to the live remote server
(`https://finn-tannlege.com/mcp`). Tools, descriptions and instructions always match the
remote service, so the npm package and the remote never drift. Remote rate limits apply.

## Remote (Streamable HTTP)

For ChatGPT and other remote MCP clients, paste this URL directly:

```
https://finn-tannlege.com/mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `tannlege_search` | Search clinics by free text, county (fylke), specialty, Helfo status, emergency care |
| `tannlege_info` | Full profile for one clinic via org_nr or UUID |
| `tannlege_stats` | Market statistics (total, per-county, Helfo count, etc.) |
| `tannlege_akutt` | Find dental clinics for emergency care, optionally filtered by county |
| `tannlege_kjeder` | List all dental chains with location counts |

## Examples

```
finn tannlege med Helfo-avtale i Oslo
kjeveortoped Bergen
akutt tannlege Stavanger
hvilke tannlegekjeder finnes i Norge?
statistikk tannleger per fylke
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `FINN_TANNLEGE_URL` | `https://finn-tannlege.com` | Override the remote base URL (or a full `/mcp` URL) |

## License

MIT
