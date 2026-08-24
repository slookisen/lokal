# Rett fra Bonden — Claude connectors directory: portal answer sheet

Every step of `claude.ai/admin-settings/directory/submissions/new`, answered.
Copy the fenced blocks verbatim. **Verified live 2026-08-24.**

---

## 1. Connection

| Field | Answer |
|---|---|
| Server type | Remote MCP server |
| Transport | Streamable HTTP |
| Server URL | `https://rettfrabonden.com/mcp` |
| Protocol versions supported | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` |

Note for whoever runs the connection test: the server is handshake-era — an `initialize`
request must precede `tools/list`. A client that sends `tools/list` first receives
`Bad Request: Server not initialized`. This is standard MCP behaviour, not a fault, and
Claude's own client does it correctly.

## 2. Authentication

| Field | Answer |
|---|---|
| Authentication | **No authentication** |

Rationale to paste if the portal asks for one:

```
The server is a public, read-mostly directory of Norwegian food producers. There are no
user accounts, so there is nothing to authenticate against. The three write tools create
anonymous pickup-order requests that are delivered to the producer; they take no
credentials and no payment details.
```

## 3. Tools

**14 tools. 11 read-only, 3 write, 0 destructive.** All carry `title`, `readOnlyHint`
and `destructiveHint` (read live from the endpoint 2026-08-24).

> **Two title fields, and they disagree.** Each tool carries a top-level `title` *and* an
> `annotations.title`. For 7 of the 14 RFB tools the two strings differ — the annotation is
> a shortened form. Both are reproduced below verbatim, because which one a client displays
> depends on the client. Do not paste one and describe it as "the" title. Logged as a
> finding on the dev-request; the divergence is a server-side data question, not something
> this documentation package can resolve.

### Read-only (11)

| Tool | `title` | `annotations.title` | What it does |
|---|---|---|---|
| `lokal_search` | Search local food producers | *(same)* | Free-text search; returns producers with contact details and their product **names**. It returns no prices — the response defers explicitly ("Bruk `lokal_info` … for full prisliste"). |
| `lokal_discover` | Discover producers by filter | *(same)* | Filtered discovery. Live `inputSchema` accepts `categories`, `tags`, `lat`, `lng`, `maxDistanceKm`, `limit` — certification filtering goes through `tags`; there is no separate region or trust-score parameter. |
| `lokal_info` | Producer details | *(same)* | Full detail record for one producer. |
| `lokal_stats` | Platform statistics | *(same)* | Totals and coverage across the catalogue. |
| `lokal_list_umbrellas` | List umbrella organizations | *(same)* | The 72 umbrellas live today: 14 `market_network` (Bondens marked), 57 `venue`, 1 `industry_org` (Hanen). **No REKO umbrella exists** — the server's own tool description claims one, but REKO rings are producer records, not umbrellas. Defaults to `limit: 50` and truncates silently. |
| `lokal_get_umbrella_members` | Get producers in an umbrella's network | *(same)* | Members of one umbrella. **Requires `umbrellaId` as a UUID**, and no tool currently emits umbrella UUIDs — `lokal_list_umbrellas` returns names and profile URLs only, despite its schema saying "Use lokal_list_umbrellas to find IDs". In practice this tool is not reachable end-to-end today. |
| `lokal_get_producer_affiliations` | Get a producer's umbrella affiliations | *(same)* | The inverse lookup. |
| `lokal_bm_next_markets` | Get upcoming Bondens marked events | **Upcoming Bondens marked events** | Upcoming farmers'-market dates. |
| `lokal_geocode` | Geocode a Norwegian place name | **Geocode Norwegian place** | Place name → coordinates, for location-scoped search. |
| `lokal_cart_view` | View shopping cart | **View cart** | Reads back a cart the user already created. |
| `lokal_order_status` | Get order status | **Order status** | Reads back the status of a submitted pickup order. |

### Write (3) — never destructive

| Tool | `title` | `annotations.title` | What it writes |
|---|---|---|---|
| `lokal_cart_create` | Create a shopping cart | **Create shopping cart** | Creates an empty cart. |
| `lokal_cart_add_item` | Add item to shopping cart | **Add cart item** | Adds a product line to that cart. |
| `lokal_cart_submit` | Submit cart and place pickup orders | **Submit cart** | Sends the cart to the producer(s) as a **pickup request**. |

All three report `destructiveHint: false`: they only ever create new records. Nothing in
this server deletes or overwrites user data, and no tool touches another user's data.

## 4. Use cases

Answer for the portal's "what does this connector do / does it read or write" step:

```
Rett fra Bonden is Norway's open directory of small-scale food producers — farms, farm
shops, REKO rings, farmers' markets and cooperatives. The connector lets Claude search
more than 1,600 producers by place, product type, category or certification, read a
producer's product range, look up which networks a producer belongs to, and find upcoming
farmers'-market dates. Prices appear only where a producer has supplied them — most
records today carry product names without a price.

It both reads and writes. Reading is the bulk of it (11 of 14 tools). The three write
tools let a user assemble a pickup order and send it to the producer: create a cart, add
items, submit. No payment ever happens in the conversation — the user pays the producer
directly when collecting the goods, so no card details, bank details or personal payment
data pass through the connector.
```

Concrete use cases to list:

- Travelling in Norway and looking for local food near where you are.
- Planning a farm-shop or gårdsbutikk visit, with opening hours and contact details.
- Sourcing Norwegian ingredients for a restaurant or event.
- Checking certifications (Debio organic) before buying.
- Assembling a pickup order from one or more producers.

## 5. Listing

See `listing.md` in this directory — name, tagline, description, categories, all with
character counts against the portal limits.

**Slug: `rett-fra-bonden`.** The listing slug is **PERMANENT after publication** — it
cannot be changed later. Type it deliberately.

## 6. Company

| Field | Answer |
|---|---|
| Company / developer name | Rett fra Bonden |
| Website | `https://rettfrabonden.com` |
| Support contact | `hei@rettfrabonden.com` |
| Country | Norway |

## 7. Data handling

```
The connector transmits only what the user's question requires: a search term, a place
name, a category filter, or — for a pickup order — the product lines the user chose plus
the name and contact detail they supply so the producer can reach them about the pickup.

No account exists, so no login credentials, no session tokens and no profile data are
involved. No payment data is ever handled: an order is a request to collect goods, and
payment happens between the user and the producer at pickup, outside this system.

Producer data served back is public directory information (business name, address,
opening hours, product range, certifications), sourced from public registries
(Brønnøysundregistrene), the producers' own websites, and producer-submitted updates.

Privacy policy: https://rettfrabonden.com/personvern
Terms of service: https://rettfrabonden.com/vilkar
```

## 8. Compliance

Financial-transaction question — the honest answer, which is **no**:

```
No. The connector does not process payments, does not hold funds, and does not touch card
or bank details. `lokal_cart_submit` creates a pickup REQUEST that is forwarded to the
producer; the transaction itself takes place between the buyer and the producer at
collection, outside Claude and outside this platform.
```

Regulated-content question: none. The connector serves a public business directory and
food-producer product listings. No health advice, no financial advice, no age-restricted
content beyond ordinary Norwegian retail rules that apply at the producer's own counter.

## 9. Test & launch

The server is **open — the reviewer needs no account, no key and no setup**. Full
instructions and prompts in `test-instructions.md` in this directory.

| Field | Answer |
|---|---|
| Test account needed | No — public server, no authentication |
| Icon | Upload `../assets/rfb-square-512.png` (512×512, square, full-bleed) |
| Documentation URL | `https://rettfrabonden.com/teknologi` |
| Screenshots | Not applicable — tools-only server, no UI cards |

---

## Known gaps to state honestly if asked

- **No PNG icon route on the domain.** `favicon.svg` serves 200 but is SVG;
  `favicon-192.png` 404s (dev-request `2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering`).
  The icon is therefore uploaded as a file from `../assets/`, not linked as a URL.
- **Producer count is deliberately imprecise** («over 1 600»). The platform's counters
  disagree — 1631 in `llms.txt`, 1712/1764 in `/health`, 1764 in `.well-known/mcp.json` —
  because they count different sets. A permanent listing should not pin one of them.
