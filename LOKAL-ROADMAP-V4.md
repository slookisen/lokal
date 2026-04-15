# Rett fra Bonden — Roadmap v4: Kvalitet, Sikkerhet & Selgervekst

**Dato:** 15. april 2026
**Status:** Live på https://rettfrabonden.com · 1 177 agenter · 331 byer · MCP 0.3.1 på npm
**Erstatter:** LOKAL-ROADMAP-V3.md (12. april)

---

## Hva som er oppnådd (per 15. april 2026)

### Infrastruktur & distribusjon — FERDIG ✅
| Leveranse | Status | Detaljer |
|-----------|--------|----------|
| Express + SQLite prod | ✅ Live | rettfrabonden.com, Fly.io Stockholm |
| Eget domene + SSL | ✅ Live | rettfrabonden.com (Namecheap DNS, Fly certs) |
| Custom GPT | ✅ Live | chatgpt.com/g/g-69db…lokal-norsk-matfinner |
| Claude Desktop MCP | ✅ Live | `npx lokal-mcp@latest` (npm v0.3.1) |
| MCP HTTP transport | ✅ Live | rettfrabonden.com/mcp (Streamable HTTP) |
| ChatGPT MCP (dev mode) | ✅ Live | @Lokal i ChatGPT Developer Mode |
| A2A Protocol | ✅ Live | /.well-known/agent-card.json + /a2a JSON-RPC |
| OpenAPI spec | ✅ Live | rettfrabonden.com/openapi.yaml |

### Data & enrichment — FERDIG ✅
| Leveranse | Status | Detaljer |
|-----------|--------|----------|
| Unified discovery+enrichment | ✅ Live | Én pipeline: discover → enrich → register |
| 1 177 agenter | ✅ Live | 17 kategorier, 331 byer |
| Seed-deduplisering | ✅ Live | Idempotent restart, ingen duplikater |
| Knowledge layer | ✅ Live | Adresse, åpningstider, produkter, om-tekst |

### SEO — FERDIG ✅
| Leveranse | Status | Detaljer |
|-----------|--------|----------|
| Sitemap | ✅ Live | 1 511 URLs (by-sider + produsentsider) |
| Produsent-profilsider | ✅ Live | /produsent/:slug med Schema.org JSON-LD (LocalBusiness) |
| By-sider | ✅ Live | /oslo, /bergen etc. med strukturert data |
| robots.txt | ✅ Live | Tillater alt, peker til sitemap |

### Selger-system — FERDIG ✅
| Leveranse | Status | Detaljer |
|-----------|--------|----------|
| Claim-flow | ✅ Live | E-post → 6-sifret kode → claim token |
| Magic link login | ✅ Live | Passwordless via e-post |
| Selger-dashboard | ✅ Live | Profil, produkter, åpningstider, innstillinger |
| Bulk product paste | ✅ Live | Kopier fra AI → lim inn alle produkter |
| Trust score engine | ✅ Live | 5-signal vektet formel, API med breakdown + tips |
| Analytics | ✅ Live | SQLite-basert, admin-dashboard |
| Bilde-opplasting | ✅ Live | Profilbilde + produktbilder |

### MCP Marketplace-registreringer — DELVIS ✅
| Registry | Status | Problem |
|----------|--------|---------|
| npm | ✅ LIVE | lokal-mcp@0.3.1 |
| Glama | ⚠️ Listet | "Cannot be installed" — validert ifølge bruker, men Glama UI viser ikke det |
| Smithery | ⚠️ Listet | Returnerer 403 ved direkte URL — trenger verifisering |
| mcp.so | ⏳ Innsendt | Manuell review pågår |
| Official MCP Registry | ⚠️ Ubekreftet | Var publisert, men 404 ved API-sjekk |

---

## Strategisk prinsipp (uendret)

**"MCP er produktet. Alt annet støtter MCP."**

Pluss: **Custom GPT for umiddelbar brukeradopsjon.** SEO for langsiktig Google/Bing/AI-synlighet.

---

## Roadmap: Now / Next / Later

### NOW — Kvalitet & sikkerhet (denne uken)

| # | Initiativ | Hvorfor | Status |
|---|-----------|---------|--------|
| 1 | **Fiks gjenværende sikkerhetshull** | SQL-injeksjon i analytics, svak default-nøkkel, XSS i søke-API | 🔧 Pågår |
| 2 | **Google Search Console** | 1 511 URLs venter på indeksering. Kritisk for ChatGPT (Bing) og Google | 🔧 Pågår |
| 3 | **Bing Webmaster Tools** | ChatGPT bruker Bing for websøk — direkte kanal til ChatGPT-svar | 🔧 Pågår |
| 4 | **Verifiser Glama + Smithery** | MCP-oppdagelse for Claude/Cursor-brukere | 🔧 Pågår |
| 5 | **Trust score breakdown i selger-dashboard** | Gamification-loop mangler UI — API har alt, dashboardet viser bare % | 🔧 Pågår |
| 6 | **Test og bekreft e-post-levering** | SMTP ser ut til å funke, men aldri bekreftet med ekte innboks | 🔧 Pågår |

**Milepæl:** Plattformen er sikker, synlig i søkemotorer, og klar for selger-outreach.

---

### NEXT — Selgervekst (neste 2-4 uker, mål: 20 april – 10 mai)

| # | Initiativ | Hvorfor | Avhenger av |
|---|-----------|---------|-------------|
| 7 | **Manuell outreach til 10 Oslo-selgere** | 0 verifiserte selgere er det kritiske gapet | NOW #6 (e-post bekreftet) |
| 8 | **Privacy policy + GPT Store-publisering** | Bredere ChatGPT-distribusjon | Domene-verifisering |
| 9 | **Dev.to-artikkel** | Utvikler-synlighet, backlinks | Kan starte nå |
| 10 | **A2A Registry PR** | Registrering i a2aregistry.org | Kan starte nå |
| 11 | **Backlink-kampanje** | Bli nevnt av bondensmarked.no, matmerk.no, REKO-grupper | Etter artikkel |
| 12 | **Rikere produsentbeskrivelser** | Profilsidene er tynne — enrichment-data trenger utvidelse | Kan kjøres batch |

**Milepæl:** 5+ verifiserte selgere. Første dokumenterte ChatGPT/Claude-interaksjon fra ekte bruker.

---

### LATER — Nettverkseffekter (mai–juli 2026)

| # | Initiativ | Hvorfor |
|---|-----------|---------|
| 13 | **Producer Premium (199-499 kr/mnd)** | Første inntekt — verifisert-badge, analytics, utvidet profil |
| 14 | **Seller Agent SDK** | Selgere hoster egen agent med live inventar |
| 15 | **Consumer demo-agenter** | "Lag middag av det som finnes lokalt" |
| 16 | **B2B Restaurant-modul** | Råvaresøk for restauranter (999-2999 kr/mnd) |
| 17 | **Sesongdata + prissammenligning** | Dypere verdi enn Google Places |
| 18 | **50+ verifiserte selgere i Oslo** | Kritisk masse |
| 19 | **Wikipedia + institusjonell synlighet** | Bli nevnt i autoritetskilder for AI-sitering |

---

## Sikkerhetsstatus

| # | Funn | Alvorlighet | Status |
|---|------|-------------|--------|
| 1 | Hardkodede admin-nøkler | Kritisk | ✅ Fikset (env-var satt) |
| 2 | SQL-injeksjon i analytics | Kritisk | 🔧 Fikses nå |
| 3 | Svak default analytics-nøkkel | Høy | 🔧 Fikses nå |
| 4 | Admin-nøkkel i query strings | Høy | Planlagt |
| 5 | Sårbar nodemailer | Høy | Planlagt |
| 6 | Ingen rate limit på admin | Høy | Planlagt |
| 7 | Claim-token utløper aldri | Høy | ✅ Har 30 dagers expiry i kode |
| 8 | CORS helt åpen | Medium | Planlagt |
| 9 | CSP deaktivert | Medium | Planlagt |
| 10 | Ufullstendig input-sanitering | Medium | 🔧 Fikses nå (XSS i søk) |
| 11 | Detaljerte feilmeldinger | Medium | Planlagt |
| 12 | API-nøkkelinfo eksponert | Medium | Planlagt |

---

## Målbare suksesskriterier

**10. mai 2026 (4 uker):**
- [ ] 5+ verifiserte selgere i Oslo
- [ ] Indeksert i Google (Search Console bekreftet)
- [ ] Indeksert i Bing (Webmaster Tools bekreftet)
- [ ] MCP installerbar via Glama/Smithery
- [ ] Alle kritiske sikkerhetshull lukket
- [ ] Første dokumenterte ekte kjøper-interaksjon via MCP/GPT
- [x] Lokal tilgjengelig via Claude Desktop (MCP npm)
- [x] Lokal tilgjengelig via ChatGPT (Custom GPT + MCP)
- [x] MCP HTTP-transport live
- [x] Domene registrert og i bruk

**5. juli 2026 (12 uker):**
- [ ] 20+ verifiserte Oslo-selgere
- [ ] 100+ AI-spørringer per uke
- [ ] Topp 10 i Google for "lokal mat [by]" i 3+ byer
- [ ] Privacy policy live, GPT Store-publisert
- [ ] Dev.to/Medium-artikkel publisert
- [ ] Første betalende produsent (Producer Premium)

---

## Hva som IKKE skal bygges

- **Mobile app** — AI-chatene ER appen
- **Kjøper-dashboard** — kjøperens interface er ChatGPT/Claude
- **Betalingsløsning (ennå)** — fokus på discovery først
- **Transaksjonsavgift** — for mye friksjon
- **Annonser** — undergraver tillitsmodellen
