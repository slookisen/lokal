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

## How it works

Since 0.4.0 the package is a thin stdio bridge to the live remote server
(`https://opplevagent.no/mcp`). Tools, descriptions, instructions and UI resources always
match the remote service, so the npm package and the remote never drift, and free-text
`query` reaches `discover_experiences` unchanged. Remote rate limits apply.

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
| `discover_gardssalg` | Search gårdssalg (farm-sale) drink producers by county, municipality, producer type, near-me distance, booking status — or look one up by name with `query`. Rows carry `id` (the provider_id for booking) |
| `book_gardssalg` | Submit a pending booking request to a gårdssalg producer (never confirms — the producer responds). Accepts `provider_query` (the producer's name) instead of `provider_id`, plus `requested_weekday` as a wrong-day guard, so one sentence («book et møte hos X fredag 20. okt kl. 10») becomes one call |

## Examples

```
hva kan vi finne på i Troms om vinteren?
utendørsaktiviteter i Oslo for 4 personer
opplevelser som passer i regnvær i Bergen
hvalsafari Tromsø
familievennlige aktiviteter under 500 kr
hvilke typer opplevelser finnes i Norge?
book et besøk hos Fjordgard Bryggeri fredag 23. oktober kl. 10 for 4 personer
```

## One-sentence booking (gårdssalg)

«Book et møte hos X fredag den 20. oktober klokken 10» is a single `book_gardssalg` call:

| Field | Value |
|-------|-------|
| `provider_query` | `"X"` — the producer's name as the guest said it (or `provider_id` from `discover_gardssalg`) |
| `slot_at` | `"2026-10-20T10:00"` (Europe/Oslo) |
| `requested_weekday` | `"fredag"` — if the 20th is not a Friday the tool answers `weekday_mismatch:true` with the nearest Fridays instead of booking the wrong day |
| `party_size`, `guest_name`, `guest_email` | the human guest's own details — ask for them, never invent them |

Outcomes are always honest and explicit: `provider_not_found`, `provider_ambiguous` (with candidates to put to the guest), `weekday_mismatch` (with suggestions), `paused` (the producer has not activated booking — profile link included), `outside_hours` (retry with `confirm_outside_hours:true`), or a **pending** request with `booking_ref`, the resolved `provider.navn` and `slot_at_local`. The producer is notified by email and confirms, proposes another time, or declines — the tool itself can never confirm a booking.

## What the bridge sends

Besides the tool arguments of each call, the bridge identifies itself to the remote server
in two ways: the MCP `clientInfo` (your AI client's name and version, as
"<client> via opplevagent-mcp") and a `User-Agent` header of the form `opplevagent-mcp/<version>`. This is
client statistics, not an identifier of you: no account, credentials or device identifier is
sent. The server keeps ordinary web-request logs (IP address and request metadata) for
operations and abuse prevention.

## Booking (gårdssalg)

`book_gardssalg` requires no login and is rate-limited on the server. The call sends the
guest's name and e-mail address to opplevagent.no. The request stays pending until the
producer answers; the tool never confirms a booking. Your AI client should have the guest's
explicit yes before it calls the tool.

## Trust boundary

The tool list, tool descriptions and server instructions are fetched from the remote
server (`https://opplevagent.no/mcp`) over HTTPS every time the bridge starts. This package does not pin or
freeze them, so what your AI client sees is whatever the remote service currently serves.
`OPPLEVAGENT_URL` overrides the remote URL, and every tool argument you or your AI client supply is
sent to that host. Only set it from a configuration you trust.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `OPPLEVAGENT_URL` | `https://opplevagent.no` | Override the remote base URL (or a full `/mcp` URL) |

## License

MIT
