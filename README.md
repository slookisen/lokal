# 🥬 Lokal — Local Food Agent Network for Norway

**Live:** https://rettfrabonden.com | **MCP Server:** https://rettfrabonden.com/mcp | **API Spec:** https://rettfrabonden.com/openapi.yaml

Lokal is the discovery layer for local food in Norway. 1,195+ producers — farms, farm shops, REKO rings, farmers markets, and cooperatives — discoverable by AI agents and humans alike.

Not an app. Not a webshop. **Infrastructure** — the DNS for food agents.

## Use Lokal

### From Claude (remote MCP via Claude Connectors)

The recommended setup for Claude.ai users: connect the remote MCP server directly, no local install required.

- **MCP Server URL:** `https://rettfrabonden.com/mcp`
- **Transport:** Streamable HTTP (MCP protocol 2025-06-18)
- **Authentication:** None required — the server is publicly accessible

Once connected, ask Claude things like:
- *"Finn økologiske grønnsaker nær Oslo som leverer hjem"*
- *"Which dairy farms in Rogaland sell raw milk directly to consumers?"*
- *"Compare three honey producers in Innlandet — who ships nationwide?"*

### From Claude Desktop (MCP stdio)

If you prefer a local install over remote:

```json
{
  "mcpServers": {
    "lokal": {
      "command": "npx",
      "args": ["lokal-mcp"]
    }
  }
}
```

### From ChatGPT (Developer Mode / Custom GPT)

**Developer Mode:** Add `https://rettfrabonden.com/mcp` as the MCP server URL.

**Custom GPT:** Create a GPT with Actions pointing to `https://rettfrabonden.com/openapi.yaml`. Instructions in [`custom-gpt-instructions.md`](custom-gpt-instructions.md).

### From your own agent (A2A / REST)

```bash
# Natural language search
curl "https://rettfrabonden.com/api/marketplace/search?q=organic+vegetables+near+Oslo"

# Structured discovery
curl -X POST https://rettfrabonden.com/api/marketplace/discover \
  -H "Content-Type: application/json" \
  -d '{"categories":["vegetables"],"tags":["organic"],"lat":59.91,"lng":10.75,"maxDistanceKm":30}'

# A2A JSON-RPC
curl -X POST https://rettfrabonden.com/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"role":"user","parts":[{"type":"text","text":"Find cheese near Bergen"}]}},"id":"1"}'
```

## MCP Tools & Resources

The remote MCP endpoint at `/mcp` exposes four tools and two resources.

| Tool | Purpose | Read/Write |
|------|---------|------------|
| `lokal_search` | Natural-language producer search (NO/EN). Auto-starts a conversation with top matches so sellers can respond. | Read + Write |
| `lokal_discover` | Structured filter — categories, tags, geo-radius. Auto-starts conversations. | Read + Write |
| `lokal_info` | Full producer profile — address, products, opening hours, certifications. | Read only |
| `lokal_stats` | Platform-level metrics — total agents, cities covered. | Read only |

| Resource URI | Mime | Description |
|--------------|------|-------------|
| `lokal://producers/overview` | `text/plain` | Aggregate view of producers by city |
| `lokal://producers/{agentId}` | `application/json` | Detailed info about a specific producer |

## HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST/GET/DELETE | MCP Streamable HTTP (remote MCP transport) |
| `/api/marketplace/search?q=...` | GET | Natural language search (NO/EN) |
| `/api/marketplace/discover` | POST | Structured filtering |
| `/api/marketplace/agents/:id/info` | GET | Producer details |
| `/api/stats` | GET | Platform statistics |
| `/a2a` | POST | A2A JSON-RPC 2.0 |
| `/.well-known/agent-card.json` | GET | A2A Agent Card |
| `/.well-known/mcp/server-card.json` | GET | MCP Server Card (human + machine-readable metadata) |
| `/openapi.yaml` | GET | OpenAPI 3.1 spec |
| `/llms.txt` | GET | AI-discovery index |
| `/privacy` | GET | Privacy policy (NO/EN) |

Full spec: https://rettfrabonden.com/openapi.yaml

## Architecture

- **TypeScript + Express** on Fly.io
- **SQLite** with WAL mode, persistent volume
- **MCP 2025-06-18** over Streamable HTTP + stdio (remote + local)
- **A2A v1.0.0** compliant (JSON-RPC 2.0 + Agent Card)
- **Value-based matching** — no ads, no pay-to-rank
- **1,195+ agents** across 360+ Norwegian cities

## For producers

Your farm/market might already be listed. Visit https://rettfrabonden.com to check, and claim your agent to update your info and respond to buyer queries.

## Troubleshooting

**"The connector can't reach the server"**
Check that your client is pointed at `https://rettfrabonden.com/mcp` (HTTPS, no trailing slash). The server uses the Streamable HTTP transport — stdio clients should use the `lokal-mcp` npm package instead.

**"CORS error in the browser"**
Browser-based MCP clients must send an `Origin` header. The server allow-lists `https://claude.ai`, `https://www.claude.ai`, `https://chatgpt.com`, and `https://chat.openai.com`. If you're hosting your own agent on a different origin, open an issue and we'll add it.

**"tools/list returns an empty array"**
Hit `POST /mcp` with a proper `initialize` request first and capture the `Mcp-Session-Id` response header. Subsequent calls must include that header — session IDs are sticky per connection.

**"Search returns no results for a Norwegian query"**
The server handles both NO and EN, but accents matter. Use `økologisk` rather than `okologisk` for best relevance. Try widening with `lokal_discover` — it accepts lat/lng + radius instead of free text.

**"I claimed my agent but the dashboard is empty"**
Claims are verified by email. Check spam for the verification code from `kontakt@rettfrabonden.com`. The token is valid for 24 hours.

**Rate limits**
Public endpoints allow 150 searches and 300 general API calls per 15-minute window. MCP `tools/call` counts against the search bucket. If your agent hits the limit, back off for 15 minutes — we don't block IPs, only throttle.

**Still stuck**
Open an issue at https://github.com/slookisen/lokal/issues with the request payload (redact anything sensitive) and the response status code.

## Privacy, Terms & Support

- **Privacy policy:** https://rettfrabonden.com/privacy
- **Terms of service:** https://rettfrabonden.com/terms
- **Issues / support:** https://github.com/slookisen/lokal/issues

## License

MIT
