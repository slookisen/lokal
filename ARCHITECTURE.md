# Lokal — Production Architecture Decision Record

## 1. Problem: Hva mangler i nåværende kode

Etter grundig gjennomgang av kodebasen identifiserer jeg **7 kritiske gap** mellom MVP og produksjon:

### Gap 1: Data forsvinner ved restart
Hele staten lever i `Map<string, T>` i RAM. Én restart = alt borte. Seed-data maskerer dette, men ekte produsenter som registrerer seg mister alt.

### Gap 2: A2A-protokollen er ikke fulgt
Vår `/.well-known/agent.json` returnerer et custom format. Den ekte A2A-spesifikasjonen krever:
- `interfaces` array med `{ type: "json-rpc", url: "..." }`
- JSON-RPC 2.0 metoder: `SendMessage`, `GetTask`, `ListTasks`
- Standard `AgentCard` schema med `id`, `provider`, `capabilities`, `skills`
- Endepunkt: `/.well-known/a2a-agent-card` (IKKE `agent.json`)

### Gap 3: Ingen JSON-RPC
A2A bruker JSON-RPC 2.0, ikke REST. Consumer-agenter skal sende:
```json
{"jsonrpc":"2.0","method":"SendMessage","params":{...},"id":"1"}
```
Vi har bare REST-endepunkter. Ingen A2A-kompatibel agent kan snakke med oss.

### Gap 4: Discovery-registry og product-search er separate systemer
`marketplace-registry.ts` og `matching-engine.ts` vet ikke om hverandre. En agent som finner en produsent via registry kan ikke direkte søke produktene deres.

### Gap 5: Ingen autentisering mellom agenter
A2A krever `securitySchemes` i Agent Card. Vi har API-nøkler men ingen middleware som validerer dem.

### Gap 6: Geo-søk er O(n)
Haversine på alle agenter/produkter fungerer for 36 agenter. Med 1000+ produsenter kollapser det.

### Gap 7: Ingen task/session-tracking
A2A har et task-lifecycle: `submitted → working → input-required → completed/failed`. Vi har bare instant request/response.

---

## 2. Beslutning: Database

### Evaluerte alternativer

| Alternativ | Fordeler | Ulemper | Passer for Lokal? |
|---|---|---|---|
| **PostgreSQL + PostGIS** | Gullstandard for geo, skalerer, SQL | Krever hosting, ops-overhead | Ja, men overkill for MVP→beta |
| **Supabase** | Hosted Postgres + PostGIS + realtime + auth gratis tier | Vendor lock-in, 500MB gratis | Ja for rask start, men begrensninger |
| **SQLite (better-sqlite3)** | Null ops, en fil, 2000+ qps, synkront | Ingen native geo-indeks, single-writer | **Ja — best fit for fase 1-3** |

### Valg: SQLite med better-sqlite3

**Hvorfor:**
1. **Null infrastruktur.** Databasen er én fil i repo. `npm run dev` fungerer uten Docker, uten cloud, uten config. Produsenter kan teste lokalt.
2. **Rask nok.** 2000+ queries/sekund med joins. Vi trenger <100 qps i beta.
3. **Geo fungerer uten PostGIS.** For Oslo (10x10km) er Haversine med en bounding-box pre-filter i SQL tilstrekkelig. Spatial index er overkill under 10.000 produsenter.
4. **Enkel migrering.** SQL er SQL. Når vi trenger PostGIS, migrerer vi schema 1:1.
5. **Persistent.** Alle data overlever restart — det kritiske gapet vi fikser.

**Migreringsstrategi:** SQLite nå → PostgreSQL/Supabase når vi treffer 1000+ produsenter eller trenger concurrent writes fra mange produsenter.

---

## 3. Beslutning: A2A-protokoll compliance

### Fase 1 (nå): Hybrid REST + JSON-RPC
- Beholde REST for dashboard/web (humans trenger det)
- Legge til JSON-RPC endepunkt på `/a2a` for agent-til-agent
- Fikse Agent Card til offisiell spec

### Fase 2: Full JSON-RPC med task lifecycle
- `SendMessage` → oppretter task
- `GetTask` → sjekk status
- Task states: submitted → working → completed

### Hva vi implementerer NÅ:
```
POST /a2a                    — JSON-RPC 2.0 endpoint
GET  /.well-known/agent.json — A2A Agent Card (corrected schema)
```

Støttede metoder:
- `message/send` — Consumer sender søk, får resultater tilbake
- `agent/authenticatedExtendedCard` — Utvidet kort med live inventory

---

## 4. Ny arkitektur

```
┌──────────────────────────────────────────────────────┐
│                    LOKAL v2                           │
├──────────────┬───────────────┬───────────────────────┤
│  REST API    │  JSON-RPC     │  Static Files         │
│  /api/*      │  /a2a         │  /public/*            │
│  (humans)    │  (agents)     │  (dashboard)          │
├──────────────┴───────────────┴───────────────────────┤
│              Service Layer                           │
│  ┌─────────┬──────────┬──────────┬─────────────┐    │
│  │Registry │Matching  │Tasks     │Agent Card   │    │
│  │Service  │Engine    │Service   │Service      │    │
│  └────┬────┴────┬─────┴────┬─────┴──────┬──────┘    │
├───────┴─────────┴──────────┴────────────┴────────────┤
│              SQLite (better-sqlite3)                  │
│  ┌─────────┬──────────┬──────────┬─────────────┐    │
│  │agents   │listings  │tasks     │chain_prices  │    │
│  │         │          │          │              │    │
│  └─────────┴──────────┴──────────┴─────────────┘    │
└──────────────────────────────────────────────────────┘
```

### Database Schema

```sql
-- Agenter (produsenter, logistics, quality, etc.)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  provider TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  url TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('producer','consumer','logistics','quality','price-intel')),
  api_key TEXT UNIQUE NOT NULL,
  lat REAL, lng REAL,
  city TEXT,
  radius_km REAL,
  categories TEXT,  -- JSON array
  tags TEXT,        -- JSON array
  skills TEXT,      -- JSON array
  trust_score REAL DEFAULT 0.5,
  is_active INTEGER DEFAULT 1,
  is_verified INTEGER DEFAULT 0,
  discovery_count INTEGER DEFAULT 0,
  interaction_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now'))
);

-- Listings (hva er til salgs akkurat nå)
CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  product_name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  quantity REAL,
  unit TEXT,
  price_per_unit REAL,
  currency TEXT DEFAULT 'NOK',
  is_organic INTEGER DEFAULT 0,
  image_url TEXT,
  available_from TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  lat REAL, lng REAL,  -- can override agent location
  delivery_options TEXT,  -- JSON array
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Tasks (A2A task lifecycle)
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  consumer_agent_id TEXT,
  method TEXT NOT NULL,
  params TEXT,  -- JSON
  status TEXT DEFAULT 'submitted' CHECK(status IN ('submitted','working','input-required','completed','failed','canceled')),
  result TEXT,  -- JSON
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Kjedepriser (for sammenligning)
CREATE TABLE chain_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_name TEXT NOT NULL,
  chain TEXT NOT NULL,
  price_per_unit REAL NOT NULL,
  is_organic INTEGER DEFAULT 0,
  scraped_at TEXT DEFAULT (datetime('now')),
  UNIQUE(product_name, chain, is_organic)
);

-- Geo bounding box index for rask filtrering
CREATE INDEX idx_agents_geo ON agents(lat, lng) WHERE is_active = 1;
CREATE INDEX idx_listings_geo ON listings(lat, lng);
CREATE INDEX idx_listings_agent ON listings(agent_id);
CREATE INDEX idx_listings_category ON listings(category);
CREATE INDEX idx_agents_role ON agents(role);
```

### Bounding-box geo-filter (erstatter full Haversine scan)

```sql
-- Finn agenter innen ~5km fra Grünerløkka (59.9225, 10.7584)
-- Bounding box: ±0.045 lat, ±0.09 lng (tilsvarer ~5km i Oslo)
SELECT * FROM agents
WHERE lat BETWEEN 59.8775 AND 59.9675
  AND lng BETWEEN 10.6684 AND 10.8484
  AND is_active = 1
  AND role = 'producer';
-- Deretter Haversine kun på de ~10-20 treffene (ikke alle 1000+)
```

---

## 5. Hva dette betyr for brukere

### For produsenter (bønder, butikker):
- Registrering persisterer. Restart/nedetid sletter ikke dataen.
- API-nøkkel fungerer permanent.
- Listings med tidsstempel og utløp.

### For forbruker-agenter (ChatGPT, Claude, etc.):
- Standard A2A JSON-RPC fungerer.
- Discovery via `/.well-known/agent.json` følger offisiell spec.
- Task-basert interaksjon med status-tracking.

### For dashboardet:
- Viser ekte, persistent data.
- Statistikk overlever restart.
