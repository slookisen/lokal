# Rett fra Bonden MCP
MCP server for Rett fra Bonden — find local food producers in Norway from Claude Desktop, ChatGPT, Cursor, and other AI clients.

More than 1,600 verified producers: farms, REKO rings, farmers' markets, farm shops, and cooperatives across Norway.

**Tools (stdio/npm and .mcpb):** `lokal_search`, `lokal_discover`, `lokal_info`, `lokal_stats`, `lokal_list_umbrellas`, `lokal_get_umbrella_members`, `lokal_get_producer_affiliations`, `lokal_geocode`

**Claude Desktop extension:** `lokal-mcp.mcpb` in this folder (Settings → Extensions → Advanced settings → Install Extension…). Rebuild with `npx @anthropic-ai/mcpb pack . lokal-mcp.mcpb` after `npm ci --omit=dev`.

**Claude Desktop config:**
```json
{"mcpServers":{"lokal":{"command":"npx","args":["lokal-mcp"]}}}
```

**Remote HTTP (Streamable HTTP):** `https://rettfrabonden.com/mcp`

More: https://rettfrabonden.com/teknologi
