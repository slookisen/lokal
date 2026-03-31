# Lokal — Oppsettguide

Denne guiden tar deg gjennom tre steg: kjøre lokalt, koble til Claude Desktop via MCP, og deploye til en offentlig URL.

Forutsetninger: Node.js 20+ installert, og prosjektet ligger i:
```
C:\Users\dafre\OneDrive\Documents\Claude\Projects\A2A\lokal
```

---

## Steg 1: Kjør lokalt

Åpne PowerShell og naviger til prosjektmappen:

```powershell
cd C:\Users\dafre\OneDrive\Documents\Claude\Projects\A2A\lokal
```

Installer avhengigheter (trenger bare gjøres én gang, eller etter endringer i package.json):

```powershell
npm install
```

Start serveren:

```powershell
npm start
```

Du skal se noe slikt:

```
💾 Initializing SQLite database...
🏙️  Database already has 316 agents — skipping seed.
🥬 Lokal API v0.11.0 running at http://localhost:3000
```

Verifiser at det fungerer — åpne en ny PowerShell og kjør:

```powershell
curl http://localhost:3000/health
```

Forventet svar:

```json
{"status":"ok","service":"lokal","version":"0.11.0","database":"sqlite"}
```

Åpne dashboardet i nettleseren: http://localhost:3000

La serveren kjøre i bakgrunnen mens du gjør steg 2.

---

## Steg 2: Koble Lokal til Claude Desktop som MCP-server

Dette gjør at du kan spørre Claude "finn lokal honning i Oslo" og Claude bruker Lokal-API-et direkte.

### 2a. Finn Claude Desktop config-filen

Åpne filutforskeren og naviger til:

```
%APPDATA%\Claude\
```

Eller i PowerShell:

```powershell
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

Hvis filen ikke finnes, opprett den.

### 2b. Legg til Lokal som MCP-server

Filen skal se slik ut. Hvis du allerede har andre MCP-servere, legg til "lokal"-blokken inni den eksisterende `mcpServers`:

```json
{
  "mcpServers": {
    "lokal": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "C:\\Users\\dafre\\OneDrive\\Documents\\Claude\\Projects\\A2A\\lokal",
      "env": {
        "LOKAL_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

Viktig: Doble backslash i stien (`\\`), og sørg for at JSON-syntaksen er gyldig.

### 2c. Start Claude Desktop på nytt

Lukk Claude Desktop helt (sjekk at den ikke kjører i system tray), og åpne den igjen.

### 2d. Verifiser at MCP er koblet til

I Claude Desktop, se etter et verktøy-ikon (hammer) i chatvinduet. Klikk på det — du skal se 5 Lokal-verktøy:

- **lokal_search** — Naturlig språk-søk
- **lokal_discover** — Strukturert søk med filtre
- **lokal_register** — Registrer ny produsent
- **lokal_info** — Plattformstatistikk
- **lokal_jsonrpc** — Rå A2A JSON-RPC

### 2e. Test det

Skriv til Claude:

```
Finn ferske grønnsaker nær Grünerløkka i Oslo
```

Claude skal kalle `lokal_search` og vise resultater fra databasen din.

Husk: Lokal-serveren (steg 1) må kjøre i bakgrunnen for at MCP-serveren skal fungere.

---

## Steg 3: Deploy til offentlig URL

Når Lokal kjører på en offentlig URL, kan enhver A2A-kompatibel agent oppdage den via `/.well-known/agent.json`.

### Alternativ A: Render.com (anbefalt for start)

#### 3a-1. Push til GitHub

Hvis du ikke allerede har et GitHub-repo:

```powershell
cd C:\Users\dafre\OneDrive\Documents\Claude\Projects\A2A\lokal
git init
git add .
git commit -m "Lokal v0.11.0 — A2A agent marketplace for local food"
```

Opprett et repo på github.com (f.eks. `lokal-api`), og push:

```powershell
git remote add origin https://github.com/DITT-BRUKERNAVN/lokal-api.git
git push -u origin main
```

#### 3a-2. Koble til Render

1. Gå til https://render.com og logg inn (GitHub-login fungerer)
2. Klikk **New** → **Web Service**
3. Velg GitHub-repoet ditt (`lokal-api`)
4. Render oppdager `render.yaml` automatisk. Hvis ikke, sett manuelt:
   - **Build Command:** `npm install`
   - **Start Command:** `npx tsx src/index.ts`
   - **Environment:** Node
5. Legg til environment variables:
   - `NODE_ENV` = `production`
   - `DB_PATH` = `/opt/render/project/data/lokal.db`
   - `BASE_URL` = `https://lokal-api.onrender.com` (bruk din faktiske URL)
6. Under **Disk**: Legg til en disk med mount path `/opt/render/project/data` (1 GB)
7. Klikk **Create Web Service**

Vent 2-3 minutter. Når deploy er ferdig, verifiser:

```
https://lokal-api.onrender.com/health
https://lokal-api.onrender.com/.well-known/agent.json
```

#### 3a-3. Oppdater MCP-config til å peke på produksjon

Når du vil at Claude Desktop skal bruke den offentlige URLen:

```json
{
  "mcpServers": {
    "lokal": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "C:\\Users\\dafre\\OneDrive\\Documents\\Claude\\Projects\\A2A\\lokal",
      "env": {
        "LOKAL_API_URL": "https://lokal-api.onrender.com"
      }
    }
  }
}
```

### Alternativ B: Railway.app

1. Gå til https://railway.app og logg inn
2. **New Project** → **Deploy from GitHub repo**
3. Velg repoet, Railway oppdager Dockerfile automatisk
4. Legg til environment variables: `PORT=3000`, `DB_PATH=/app/data/lokal.db`, `BASE_URL=https://din-app.railway.app`
5. Legg til **Volume** mounted på `/app/data`
6. Deploy

### Alternativ C: Fly.io

```powershell
# Installer flyctl: https://fly.io/docs/getting-started/installing-flyctl/
fly launch
fly volumes create lokal_data --size 1
fly deploy
```

---

## Feilsøking

**"better_sqlite3.node is not a valid Win32 application"**
Native binary er kompilert for feil OS. Kjør:
```powershell
Remove-Item -Recurse -Force node_modules
npm install
```

**MCP-server viser ingen verktøy i Claude Desktop**
- Sjekk at JSON i config-filen er gyldig (ingen manglende komma)
- Sjekk at stien til prosjektet er riktig
- Sjekk at `npx tsx` fungerer: `npx tsx --version`
- Sjekk Claude Desktop-loggene: `%APPDATA%\Claude\logs\`

**"EACCES" under npm install**
Lukk alle andre programmer som kan låse filer (VS Code, annen terminal), og prøv igjen.

**Serveren starter men ingen agenter vises**
Slett databasefilen og start på nytt:
```powershell
Remove-Item data\lokal.db
npm start
```

**Render deploy feiler**
- Sjekk at `render.yaml` er i rot av repoet
- Sjekk at `npm install` fungerer lokalt først
- Sjekk build-loggene i Render-dashboardet

---

## Verifiser alt fungerer

Når alt er på plass, test hele kjeden:

1. **Lokal server:** `curl http://localhost:3000/health` → `{"status":"ok"}`
2. **Agent Card:** `curl http://localhost:3000/.well-known/agent.json` → JSON med skills og interfaces
3. **JSON-RPC:** Send en POST til `/a2a` med `message/send`
4. **MCP i Claude:** Spør "finn lokal mat i Bergen" → Claude kaller lokal_search
5. **Offentlig URL:** `https://din-url.onrender.com/.well-known/agent.json` → Synlig for hele verden
