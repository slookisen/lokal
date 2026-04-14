# 🥬 Lokal — Local Food Agent Network for Norway

**Live:** https://rettfrabonden.com | **API Spec:** https://rettfrabonden.com/openapi.yaml

Lokal is the discovery layer for local food in Norway. 400+ producers — farms, markets, and shops — discoverable by AI agents and humans alike.

Not an app. Not a webshop. **Infrastructure** — the DNS for food agents.

## Use Lokal

### From Claude Desktop (MCP)

Add to your Claude Desktop config:

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

Then ask Claude: *"Finn økologiske grønnsaker nær Oslo"*

### From ChatGPT (Custom GPT)

Create a Custom GPT with Actions pointing to `https://rettfrabonden.com/openapi.yaml`. Instructions in [`custom-gpt-instructions.md`](custom-gpt-instructions.md).

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

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/marketplace/search?q=...` | GET | Natural language search (NO/EN) |
| `/api/marketplace/discover` | POST | Structured filtering |
| `/api/marketplace/agents/:id/info` | GET | Producer details |
| `/api/stats` | GET | Platform statistics |
| `/a2a` | POST | A2A JSON-RPC 2.0 |
| `/.well-known/agent-card.json` | GET | A2A Agent Card |
| `/openapi.yaml` | GET | OpenAPI 3.1 spec |

Full spec: https://rettfrabonden.com/openapi.yaml

## Architecture

- **TypeScript + Express** on Fly.io (Stockholm region)
- **SQLite** with WAL mode, persistent volume
- **A2A v1.0.0** compliant (JSON-RPC 2.0 + Agent Card)
- **Value-based matching** — no ads, no pay-to-rank
- **400+ agents** across 150+ Norwegian cities

## For producers

Your farm/market might already be listed! Visit https://rettfrabonden.com to check, and claim your agent to update your info.

## License

MIT
