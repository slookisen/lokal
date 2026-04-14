# Rett fra Bonden — Monetiserings-roadmap

*Sist oppdatert: 14. april 2026*

---

## Visjon

Rett fra Bonden eier datalaget som AI-assistenter bruker for å svare på matspørsmål i Norge. Koden er åpen, men verdien sitter i produsentdataene (1169+), AI-distribusjonen (ChatGPT, MCP, A2A), og nettverkseffekten. Strategien er å bygge inntekt som beviser forretningsmodellen, og posisjonere for oppkjøp innen 12–18 måneder.

---

## Fase 1: Producer Premium (Q2 2026)

**Mål:** Første inntekt. Bevise at produsenter betaler for synlighet.

### Gratisnivå (som i dag)
- Synlig i AI-søk (ChatGPT, Claude, A2A)
- Basisprofil med kontaktinfo og åpningstider
- Søkbar på rettfrabonden.com

### Betalt nivå — «Rett fra Bonden Pro» (199–499 kr/mnd)
- **Verifisert-badge** — grønt merke i AI-svar og på nettsiden, bygger tillit
- **AI-analytics** — «Du ble anbefalt 47 ganger denne uken», «Mest etterspurt: grønnsaker i Oslo»
- **Utvidet profil** — bilder, produktkatalog med priser, sesongkalender, sertifiseringer
- **Prioritert visning** — vises øverst i AI-svar og søkeresultater
- **Kundeleads** — eksport av kontaktforespørsler, integrasjon med e-post
- **Sosiale medier-pakke** — auto-generert innhold: «Denne uken hos [gård]: ferske jordbær»

### Teknisk implementasjon
- Betalingsintegrasjon: Stripe (norske kort + Vipps via Stripe)
- Nytt felt i agents-tabellen: `subscription_tier` (free/pro)
- Pro-badge i SEO-sider og AI-responser
- Analytics-dashboard utvidelse av eksisterende /selger

### KPI-er
- 20 betalende produsenter innen august 2026
- MRR-mål: 5 000–10 000 kr/mnd

---

## Fase 2: B2B — Restauranter og innkjøpere (Q3–Q4 2026)

**Mål:** Høyere ARPU. Vise at modellen skalerer til B2B.

### Produkt — «Rett fra Bonden for Bedrift»
- **Råvaresøk** — søk etter ingrediens + region + sesong, f.eks. «økologisk lam innen 50 km fra Oslo»
- **Leverandørkatalog** — filtrering på sertifiseringer, kapasitet, leveringsområde
- **Direkte kontakt** — meldingssystem mellom restaurant og produsent
- **Sesongkalender** — når er hva tilgjengelig, planlegg menyen etter sesong
- **Bestillingshistorikk** — logg over tidligere leverandørforhold

### Prising
- Basis: 999 kr/mnd (søk + kontakt)
- Pro: 2 999 kr/mnd (+ analytics, prioritert tilgang, API-integrasjon med deres POS)

### Go-to-market
- Start med 10 restauranter i Oslo som allerede promoterer lokal mat
- Partnerskap med Matmerk for troverdighet
- Casehistorie: «Slik fant Restaurant X sin nye eplecider-leverandør»

### KPI-er
- 10 betalende restauranter innen Q4 2026
- MRR-mål: 20 000–50 000 kr/mnd (akkumulert med Fase 1)

---

## Markedsføring og merkevarebygging

### Influenser-strategi
Lokal mat og bærekraft er allerede trending. Vi trenger ikke betale for oppmerksomhet — vi trenger å gjøre det enkelt for influensere å bruke plattformen.

**Tilnærming:**
- **Matbloggere og Instagram** — «Spør ChatGPT hvor du finner ferske jordbær nær deg, og se hva som skjer» — dette er innhold som lager seg selv. Influenseren viser AI-en i aksjon, vi får organisk spredning.
- **Kokker med profil** — restaurantkokker som allerede promoterer «farm-to-table» er naturlige ambassadører for B2B-produktet.
- **TikTok/Reels-format** — kort demo: «Jeg spurte AI-en min om lokal mat i Bergen, her er hva den fant» → viser faktiske resultater fra Rett fra Bonden.
- **Sesongtemaer** — «Jordbærsesong er her → spør AI-en din» — koble til naturlige hendelser.

**Kostnad:** Lav. De fleste mat-influensere i Norge er mikro-influensere (1k–50k følgere) som samarbeider for produkttilgang og god historie, ikke store honorarer.

**Nøkkelkanaler:** Instagram, TikTok, matblogger-nettverk, REKO-ringen-grupper på Facebook.

### Forskning og institusjonell troverdighet
- **NMBU (Norges miljø- og biovitenskapelige universitet)** — samarbeid om forskning på digitalisering av kortreist mat.
- **NIBIO** — data om matproduksjon i Norge, kan berike plattformen.
- **Innovasjon Norge** — søk om støtte til «AI-infrastruktur for norsk matkultur». Posisjonér som innovasjonsprosjekt, ikke bare en markedsplass.
- **Fylkeskommuner** — lokale matsatsinger (f.eks. «Smak av Trøndelag») kan bruke Rett fra Bonden som sin digitale infrastruktur.

**Hvorfor dette fungerer:** Akademisk validering og offentlig støtte gir troverdighet som reklame aldri kan kjøpe. Det signaliserer til potensielle kjøpere at dette er seriøs infrastruktur, ikke bare et sideprosjekt.

---

## Fase 3: Posisjonering for oppkjøp (2027)

### Hva gjør oss attraktive
- **Data-moat** — mest komplette strukturerte database over norske matprodusenter
- **AI-distribusjon** — allerede integrert i ChatGPT, Claude, A2A — ikke trivielt å kopiere
- **Bevist inntekt** — MRR fra produsenter + restauranter
- **Åpen kildekode** — paradoksalt nok øker dette verdien fordi det bygger tillit og fellesskap
- **Skalerbar modell** — konseptet fungerer i Sverige, Danmark, Finland uten å bygge om

### Potensielle kjøpere
| Kjøper | Motivasjon | Estimert verdi |
|--------|-----------|---------------|
| Norgesgruppen / Coop | Lokal-mat-troverdighet, ESG-rapportering | 5–15 MNOK |
| Oda (Kolonial) | Utvide sortiment med lokal mat, AI-infrastruktur | 10–20 MNOK |
| Matmerk / Bondelaget | Digital infrastruktur for norsk landbruk | 3–8 MNOK |
| Internasjonal food-tech | Modell for andre markeder (Norden, EU) | 15–50 MNOK |

*Verdiestimatene er grove og avhenger av vekstkurve, MRR, og strategisk fit.*

### Hva vi trenger å vise
- Vekstkurve i produsenter og brukere (mål: 3000+ produsenter)
- Betalingsvilje (MRR > 50 000 kr/mnd)
- AI-trafikk-data (antall ganger anbefalt av ChatGPT/Claude)
- Mediadekning og institusjonell validering

---

## Inntektsstrømmer — prioritert

| # | Inntektsstrøm | Tidslinje | Kompleksitet | Potensial |
|---|--------------|-----------|-------------|-----------|
| 1 | Producer Premium | Nå → Q2 2026 | Lav | 5–10k/mnd |
| 2 | B2B Restaurant | Q3–Q4 2026 | Medium | 20–50k/mnd |
| 3 | Oppkjøp | 2027 | — | 5–50 MNOK |
| 4 | API/data-lisensiering | Q4 2026+ | Lav | 5–15k/mnd |
| 5 | Partnerskap/offentlig støtte | Løpende | Medium | Variabelt |

---

## Det vi IKKE gjør
- **Transaksjonsavgift** — for mye friksjon, krever betalingsinfrastruktur og logistikk
- **Annonser** — undergraver tilliten og «fellesgode»-budskapet
- **Paywall på AI-tilgang** — ødelegger nettverkseffekten som er hele moaten
- **Konkurrere på logistikk** — vi er discovery-laget, ikke leveringsselskapet
