# Rett fra Bonden MCP
MCP server for Rett fra Bonden — find local food producers in Norway from Claude Desktop, ChatGPT, Cursor, and other AI clients.

More than 1,500 verified producers: farms, REKO rings, farmers' markets, farm shops, and cooperatives across Norway.

**How it works:** since 0.5.0 the package is a thin stdio bridge to the live remote server (`https://rettfrabonden.com/mcp`). Tools, descriptions and instructions always match the remote service, so the npm package, the `.mcpb` extension and the remote never drift. Remote rate limits apply.

**Tools (stdio/npm and .mcpb, same as the remote):** `lokal_search`, `lokal_discover`, `lokal_info`, `lokal_stats`, `lokal_list_umbrellas`, `lokal_get_umbrella_members`, `lokal_get_producer_affiliations`, `lokal_bm_next_markets`, `lokal_geocode`, `lokal_find_offers`, `lokal_cart_create`, `lokal_cart_add_item`, `lokal_cart_view`, `lokal_cart_submit`, `lokal_order_status`

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
  request metadata) for operations and abuse prevention.
- **What the bridge sends about itself.** Besides the tool arguments, the bridge sends
  your AI client's name and version in the MCP `clientInfo` (as "<client> via lokal-mcp")
  and a `User-Agent` of the form `lokal-mcp/<version>`. This is client statistics and does
  not identify you: no account, credentials or device identifier is sent.
- **Who else sees it.** Nobody. Data is not sold, and it is not shared with third
  parties for advertising or profiling.
- **Third-party contact.** The cart tools (`lokal_cart_*`) are part of this
  extension since 0.5.0. If you submit a cart with `lokal_cart_submit`, the chosen
  producer is e-mailed about that pickup order, and only if the producer has opted in
  to orders through the platform. Payment is made to the producer at pickup; the
  platform never takes payment. The other tools are read-only.
- **Cart and ordering need no login.** `lokal_cart_*` require no sign-in, and
  submission is rate-limited on the server. Submission only reaches producers that have
  opted in to orders. Your AI client must get your explicit yes before it calls
  `lokal_cart_submit`, because that sends an e-mail to the producer.
- **Trust boundary.** Tools, descriptions and instructions are fetched from the remote
  server over HTTPS and are not pinned by this package. `LOKAL_URL` must come from a trusted
  configuration, because every tool argument is sent to that host.
- **Your control.** Stop sending data by removing the extension. Because no
  account exists, there is no stored profile to delete. Questions and deletion
  requests: hei@rettfrabonden.com.
- **Optional setting.** `LOKAL_URL` overrides the remote base URL; leave it unset to
  use `https://rettfrabonden.com` (see Trust boundary above).
