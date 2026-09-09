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

## Privacy Policy

Full policy: **https://rettfrabonden.com/personvern** (English: https://rettfrabonden.com/privacy).
Terms: https://rettfrabonden.com/vilkar

Summary for reviewers and users of this extension:

- **What is sent.** Only the query text and parameters you supply in a tool call
  (search terms, a place name, a producer id) are sent to `rettfrabonden.com`.
  Nothing is read from your machine: the extension has no file, shell or
  filesystem access and declares no `user_config`.
- **What is not sent.** No account, no credentials, no payment details, no
  chat history. The service has no user accounts, so there is nothing to log in to.
- **What is stored.** The server keeps ordinary web-request logs (IP address and
  request metadata) for operations and abuse prevention. Tool calls from this
  extension are not tied to a person, because no identifier is transmitted.
- **Who else sees it.** Nobody. Data is not sold, and it is not shared with third
  parties for advertising or profiling.
- **Third-party contact.** The remote endpoint additionally offers cart tools; if
  a cart is submitted there, the chosen producer is e-mailed about that order.
  Those tools are **not** part of this extension — the eight tools listed above are
  all read-only.
- **Your control.** Stop sending data by removing the extension. Because no
  account exists, there is no stored profile to delete. Questions and deletion
  requests: hei@rettfrabonden.com.
- **Optional setting.** `LOKAL_URL` overrides the API base URL; leave it unset to
  use `https://rettfrabonden.com`.
