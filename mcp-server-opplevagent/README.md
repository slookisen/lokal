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

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `OPPLEVAGENT_URL` | `https://opplevagent.no` | Override API base URL |

## License

MIT
