# Lokal — Rett fra Bonden 🌾

**AI-drevet oppdagelsesnettverk for lokal mat i Norge.**

Lokal kobler AI-agenter med 1,000+ lokale matprodusenter — gårder, bakeri, fiskehandlere, gårdsbutikker — på tvers av 100+ norske byer. Tenk DNS for mat: en AI-agent spør "hvor finner jeg økologisk honning nær Oslo?", og Lokal svarer med de beste treffene.

**Live:** [rettfrabonden.com](https://rettfrabonden.com)

---

## Bruk Lokal

### ChatGPT (enklest)
Klikk og søk — ingen oppsett:
**[Lokal Norsk Matfinner (Custom GPT)](https://chatgpt.com/g/g-69dbf8593c1c81919050f8da98cd327d-lokal-norsk-matfinner)**

### Claude Desktop (MCP)
```bash
npx lokal-mcp
```
Eller legg til i `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "lokal": {
      "command": "npx",
      "args": ["-y", "lokal-mcp"]
    }
  }
}
```

### MCP HTTP (alle klienter)
For Cursor, Windsurf, ChatGPT Developer Mode, eller andre MCP-klienter:
```
https://rettfrabonden.com/mcp
```

### A2A Protocol
Agent-til-agent kommunikasjon via JSON-RPC 2.0:
```
Endpoint: https://rettfrabonden.com/a2a
Agent Card: https://rettfrabonden.com/.well-known/agent-card.json
```

### REST API
```bash
# Naturlig språk-søk
curl "https://rettfrabonden.com/api/marketplace/search?q=økologisk+honning+oslo"

# Strukturert søk
curl -X POST "https://rettfrabonden.com/api/marketplace/discover" \
  -H "Content-Type: application/json" \
  -d '{"category": "honey", "city": "Oslo", "maxResults": 10}'
```

**Full API-dokumentasjon:** [OpenAPI Spec](https://rettfrabonden.com/openapi.yaml)

---

## Hva Lokal gjør

- **Søk** — Finn produsenter etter kategori, by, avstand, eller fritekst
- **Rangerting** — Trust score basert på datakvalitet, verifisering, og enrichment
- **Kontaktinfo** — Telefon, e-post, nettside, adresse, vCard-nedlasting
- **Agent-kommunikasjon** — A2A-protokoll for agent-til-agent forhandling
- **Multi-kanal** — Én server, tilgjengelig via ChatGPT, Claude, MCP, REST, og A2A

---

## Arkitektur

```
rettfrabonden.com (Express + SQLite)
  ├── REST API        → Custom GPT, direkte klienter
  ├── MCP HTTP        → ChatGPT, Cursor, Windsurf, alle MCP-klienter
  ├── MCP stdio (npm) → Claude Desktop
  └── A2A Protocol    → Agent-til-agent kommunikasjon
```

---

## Kjør lokalt

```bash
git clone https://github.com/slookisen/lokal.git
cd lokal
npm install
npm run dev
```

---

## Lisens

MIT

---

**Laget med kjærlighet for norsk lokalmat** 🇳🇴
