# Opplevagent — ChatGPT App submission checklist

> **Re-verified 2026-08-24 against the live endpoint.** The remote server now exposes
> **5 tools** (snake_case): `discover_experiences`, `list_experience_categories`,
> `get_experience`, `discover_gardssalg`, `book_gardssalg`. All carry `title` +
> `readOnlyHint`/`destructiveHint` annotations (`book_gardssalg` is the only
> non-read-only tool). `manifest.json` in this directory was corrected the same day
> (tool names were previously written camelCase and the two gårdssalg tools were
> missing from `description_for_model`).

## What's ready

- **MCP endpoint:** `https://opplevagent.no/mcp`
- **App manifest:** `manifest.json` in this directory (schema_version v1)
- **Icon (PNG, required by the Apps form):** `../assets/opplevagent-brand-512.png` —
  Opplevagent's OWN constellation mark (teal/olive/amber dots + orange spark on
  white), extracted 2026-08-24 from the live site header's inline SVG. Square
  512×512, no rounded corners (OpenAI crops circularly). The earlier sprout-based
  `opplevagent-square-{green,blue}-512.png` were the WRONG brand for Opplevagent
  (generated from the shared favicon.svg, which serves the RFB sprout on all hosts —
  itself a brand bug, now covered by dev-request
  `2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering`); kept only as history.
  `favicon-192.png` still 404s (re-verified 2026-08-24; same dev-request).
- **Policy URLs (both 200, re-verified 2026-08-24):**
  - Privacy: `https://opplevagent.no/personvern`
  - Terms: `https://opplevagent.no/vilkar`
- **UI components (both live, re-verified 2026-08-24):** `resources/list` returns two
  HTML card templates served via MCP
  - `ui://opplevagent/experiences-list` — card list for `discover_experiences` results
  - `ui://opplevagent/experience-detail` — detail card for `get_experience` results
- **Output templates:** `discover_experiences` and `get_experience` carry
  `_meta["openai/outputTemplate"]` pointing to the above

## Manual submission steps

1. Go to [platform.openai.com/apps](https://platform.openai.com/apps) and sign in.
2. Click **Create App** (or **+ New App**).
3. Select **MCP** as the connector type.
4. Paste the MCP URL: `https://opplevagent.no/mcp`
5. Upload `manifest.json` when prompted, or fill in the form fields from it.
6. Upload a screenshot showing ChatGPT rendering experience cards (take one after testing).
7. Review the policy URLs and contact email, then click **Submit for review**.

## Testing before submit

Connect ChatGPT to `https://opplevagent.no/mcp` in developer mode and ask:
- "Finn naturopplevelser i Vestland"
- "Hvilke kategorier finnes på opplevagent?"
- "Vis detaljer for [id from discover results]"
- "Finn gårdsutsalg i Vestfold" (exercises `discover_gardssalg`)

Verify that experience cards render inline and the Book-button links are correct.

> **⚠️ `book_gardssalg` in demos/testing:** the tool creates a REAL booking request.
> Dispatch is double-gated (`BOOKING_DISPATCH_ENABLED` + per-provider `booking_live`),
> and as of 2026-08-24 only a hidden test provider is live — but do not run
> `book_gardssalg` to completion against a real provider in a demo recording. Showing
> `discover_gardssalg` results is enough; if a booking must be shown, use the hidden
> test provider.
