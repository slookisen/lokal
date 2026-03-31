# Cowork: Seed 362 Agenter til Lokal Databasen

## Oppgave

Oppdater `src/seed-oslo-real.ts` (eller lag en ny `src/seed-norway-full.ts`) med **alle 362 agentene** fra LOKAL_SLAGPLAN.md.

## Kilde data

Alle 362 agenter er listet i `LOKAL_SLAGPLAN.md` under "Database Status (v0.11.0 — 31. mars 2026)".

### Struktur per region

Agenter er organisert etter region:
- **Oslo (inkl. bydeler)**: ~66 agenter
- **Oslo omegn**: ~25 agenter
- **Oslo utvidet**: ~22 agenter
- **Bergen**: ~25 agenter
- **Bergen utvidet**: ~5 agenter
- **Trondheim**: ~15 agenter
- **Trøndelag utvidet**: ~10 agenter
- **Stavanger/Sandnes/Jæren**: ~24 agenter
- **Tromsø**: 13 agenter
- **Bodø/Lofoten**: 9 agenter
- **Ålesund**: 2 agenter
- **Haugesund**: 2 agenter
- **Tønsberg/Nøtterøy/Andebu**: 7 agenter
- **Skien/Porsgrunn/Telemark**: 4 agenter
- **Hamar/Innlandet**: 2 agenter
- **Lillehammer**: 3 agenter
- **Moss**: 3 agenter
- **Sarpsborg/Halden**: 3 agenter
- **Kristiansand/Agder**: 7 agenter
- **Drammen/Buskerud**: 17 agenter
- **Fredrikstad/Østfold**: 10 agenter
- **37 nye REKO-byer**: 37 agenter
- **15 nye Bondens marked**: 15 agenter
- **Øvrige byer**: ~12 agenter
- **Sandefjord/Vestfold**: ~5 agenter
- **Alta, Hammerfest, Notodden, Flekkefjord, Kragerø**: 5 agenter
- **Nasjonalt/Regionalt**: 8 agenter

### Kjente produsenter fra seed-oslo-real.ts (allerede implementert)

Bruk disse som mønster for struktur:
- REKO-ringer: Vålerenga, Skøyen, Sentrum, Grorud, St. Hanshaugen
- REKO-produsenter: Sandviken Honning, Bjørnstad Skog, Delås Gård, Kaffehagen
- Bondens marked: Oslo hoved + 5 lokasjoner + enkelte produsenter
- Grønnsaksbutikker: Grønland Torg, Dagligvare, Vika, Vulkan, Sagene Torg
- Gårdsbutikker: Haneborg, Rånås, Dystergaard
- Honning: ByBi, Overnaturlig, Local Buzz, Vulkanbier
- Mathallen: Vulkanfisk, Ost & Sånt, Gutta på Haugen, Annis Pølsemakeri
- Tjenester: Foodora, Debio, Mattilsynet

## Krav

1. **Behold eksisterende agenter** — ikke slett noe som allerede finnes
2. **Legg til manglende agenter** fra alle regioner i slagplanen
3. **Bruk samme struktur** som eksisterende agenter i seed-oslo-real.ts
4. **Grupper logisk** — behold region-inndelingen
5. **Inkluder nøkkelinfo** for hver agent:
   - `name`: Navn på butikken/produsenten/ringen
   - `description`: Kort beskrivelse
   - `location`: { lat, lng, city, district (hvis relevant) }
   - `categories`: ["vegetables", "eggs", "honey", etc.]
   - `tags`: ["reko", "gårdsbutikk", "bondens-marked", etc.]
   - `url`: Hjemmeside eller Facebook-gruppe hvis oppgitt
   - `contactEmail`: Hvis oppgitt

6. **Oppdater seed-logikken** slik at:
   - Den sjekker antall agenter før seeding
   - Hvis < 362, legg til manglende
   - Hvis >= 362, skip seeding

7. **Oppdater versjonsnummer** i /health endpoint til 0.12.0 eller høyere

## Test

Etter implementasjon:
1. Start serveren: `npm start`
2. Verifiser at databasen har ~362 agenter: `curl http://localhost:3000/health`
3. Test søk på ulike regioner:
   - "finn grønnsaker i Bergen"
   - "finn REKO i Trondheim"
   - "finn gårdsbutikk i Rogaland"

## Filstruktur

Enten:
- **Alternativ A:** Utvid `src/seed-oslo-real.ts` til `src/seed-norway-full.ts` med alle regioner
- **Alternativ B:** Lag flere seed-filer per region og kall dem alle fra index.ts

Velg det som gir cleanest kode.

## Tidsbruk

Dette er en stor dataoppgave (~300+ nye agenter). Estimert 1-2 timer med copy/paste + strukturering.
