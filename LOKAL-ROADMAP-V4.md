# Rett fra Bonden — Roadmap v4: Kvalitet, Sikkerhet & Selgervekst

**Dato:** 16. april 2026
**Status:** Live på https://rettfrabonden.com · 1 177 agenter · 331 byer · MCP 0.3.1 på npm
**Erstatter:** LOKAL-ROADMAP-V3.md (12. april)
**Sist oppdatert:** 16. april 2026 — full audit mot produksjon

---

## Hva som er oppnådd (per 16. april 2026)

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
| Analytics | ✅ Live | SQLite-basert, admin-dashboard med trafikk-klassifisering |
| Bilde-opplasting | ✅ Live | Profilbilde + produktbilder |

### MCP Marketplace-registreringer — FERDIG ✅
| Registry | Status | Detaljer |
|----------|--------|---------|
| npm | ✅ Live | lokal-mcp@0.3.1 |
| Glama | ✅ Live | Listet og verifisert (301 redirect bekreftet) |
| Smithery | ✅ Live | Listet (308 redirect bekreftet) |
| mcp.so | ✅ Live | Publisert og godkjent |
| Official MCP Registry | ✅ Live | Publisert via mcp-publisher CLI |

---

## Strategisk prinsipp (uendret)

**"MCP er produktet. Alt annet støtter MCP."**

Pluss: **Custom GPT for umiddelbar brukeradopsjon.** SEO for langsiktig Google/Bing/AI-synlighet.

---

## Roadmap: Now / Next / Later

### NOW — Kvalitet & sikkerhet ✅ FERDIG

| # | Initiativ | Hvorfor | Status |
|---|-----------|---------|--------|
| 1 | **Fiks gjenværende sikkerhetshull** | SQL-injeksjon, svak default-nøkkel, XSS | ✅ Ferdig — parameteriserte spørringer, env-var nøkler, CSP aktiv |
| 2 | **Google Search Console** | 1 511 URLs venter på indeksering | ✅ Ferdig — DNS TXT verifisert (`google-site-verification=BTl8viTl0…`) |
| 3 | **Bing Webmaster Tools** | ChatGPT bruker Bing for websøk | ✅ Ferdig — Bing sender organisk trafikk (bekreftet i analytics) |
| 4 | **Verifiser Glama + Smithery** | MCP-oppdagelse for Claude/Cursor | ✅ Ferdig — begge listet og verifisert |
| 5 | **Trust score breakdown i selger-dashboard** | Gamification-loop | ✅ Ferdig — API returnerer full 5-signal breakdown, UI viser klikk-for-detaljer |
| 6 | **Test og bekreft e-post-levering** | SMTP aldri bekreftet mot ekte innboks | ✅ Ferdig — Verifisert 16. april, e-post levert til innboks |

**Milepæl: ✅ Plattformen er sikker, synlig i søkemotorer, og klar for selger-outreach.**

---

### NEXT — Selgervekst (neste 2-4 uker, mål: 20 april – 10 mai)

| # | Initiativ | Hvorfor | Status |
|---|-----------|---------|--------|
| 7 | **Manuell outreach til 10 Oslo-selgere** | 0 verifiserte selgere er det kritiske gapet | ⏳ Klar til start — SMTP bekreftet, claim-flow fungerer |
| 8 | **Privacy policy + GPT Store-publisering** | Bredere ChatGPT-distribusjon | ❌ /personvern gir 404 — må lages |
| 9 | **Dev.to-artikkel** | Utvikler-synlighet, backlinks | ⏳ Kan starte nå |
| 10 | **A2A Registry PR** | Registrering i a2aregistry.org | ⏳ Kan starte nå |
| 11 | **Backlink-kampanje** | Bli nevnt av bondensmarked.no, matmerk.no, REKO-grupper | ⏳ Etter artikkel |
| 12 | **Rikere produsentbeskrivelser** | Profilsidene er tynne — enrichment-data trenger utvidelse | ⏳ Kan kjøres batch |

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
| 1 | Hardkodede admin-nøkler | Kritisk | ✅ Fikset — bruker env-var (ADMIN_API_KEY, ANALYTICS_ADMIN_KEY) |
| 2 | SQL-injeksjon i analytics | Kritisk | ✅ Fikset — alle spørringer parameterisert |
| 3 | Svak default analytics-nøkkel | Høy | ✅ Fikset — sterk nøkkel satt via Fly secrets |
| 4 | Admin-nøkkel i query strings | Høy | ✅ Fikset — bruker X-Admin-Key header |
| 5 | Sårbar nodemailer | Høy | ⚠️ Lav risiko — nodemailer er oppdatert, men bør overvåkes |
| 6 | Ingen rate limit på admin | Høy | ✅ Fikset — adminLimiter aktiv på alle admin-ruter |
| 7 | Claim-token utløper aldri | Høy | ✅ Fikset — 30 dagers rullerende expiry |
| 8 | CORS helt åpen | Medium | ✅ Fikset — corsOptions konfigurert |
| 9 | CSP deaktivert | Medium | ✅ Fikset — full CSP-header med strenge direktiver |
| 10 | Ufullstendig input-sanitering | Medium | ✅ Fikset — parameteriserte spørringer, XSS-sanitering |
| 11 | Detaljerte feilmeldinger | Medium | ⚠️ Delvis — try-catch på kritiske ruter, men noen kan lekke info |
| 12 | API-nøkkelinfo eksponert | Medium | ✅ Fikset — nøkler kun i env-var, ikke i kode |

---

## Målbare suksesskriterier

**10. mai 2026 (4 uker):**
- [ ] 5+ verifiserte selgere i Oslo
- [x] Indeksert i Google (Search Console bekreftet)
- [x] Indeksert i Bing (Webmaster Tools — organisk trafikk bekreftet)
- [x] MCP installerbar via Glama/Smithery
- [x] Alle kritiske sikkerhetshull lukket
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
