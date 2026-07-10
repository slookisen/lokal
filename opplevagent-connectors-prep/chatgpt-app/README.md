# Opplevagent — ChatGPT App submission checklist

## What's ready

- **MCP endpoint:** `https://opplevagent.no/mcp`
- **App manifest:** `manifest.json` in this directory (schema_version v1)
- **Icon:** `https://opplevagent.no/favicon.svg` (SVG — no PNG icon route exists on opplevagent.no; verified live 2026-07-10, `favicon-192.png` 404s)
- **Policy URLs:**
  - Privacy: `https://opplevagent.no/personvern`
  - Terms: `https://opplevagent.no/vilkar`
- **UI components:** `resources/list` returns two HTML card templates served via MCP
  - `ui://opplevagent/experiences-list` — card list for `discover_experiences` results
  - `ui://opplevagent/experience-detail` — detail card for `get_experience` results
- **Output templates:** Tools carry `_meta["openai/outputTemplate"]` pointing to the above

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

Verify that experience cards render inline and the Book-button links are correct.
