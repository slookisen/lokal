# Opplevagent MCP Apps — catalog screenshots

Katalog-klare skjermbilder av de to live `ui://opplevagent/...`-kortene
(`experiences-list`, `experience-detail`), produsert for Anthropics
connectors-katalog og gjenbrukt som valgfrie screenshots i
ChatGPT Apps-innsendingen. Se `prompts.txt` for prompt/bilde-paring.

## 320px-verifisering (AC3)

Testet 2026-08-24 (`generate-screenshots.js`, `testWidths: [320]`): begge
kort-typene rendret ved en 320px CSS-viewport uten horisontal overflow
(`document.documentElement.scrollWidth <= clientWidth`, målt automatisk,
ikke antatt). **Resultat: OK — ingen fiks nødvendig.** Begge maler bruker
`viewport-width=device-width` + flyt-layout (ingen faste breddepiksler,
`badge`-spennene er `inline-block` og wrapper naturlig), så dette var
forventet, men bekreftet mekanisk fremfor antatt.

## Hvordan bildene ble laget

`generate-screenshots.js` leser `EXPERIENCES_LIST_HTML`/`EXPERIENCE_DETAIL_HTML`
direkte fra `src/routes/experiences-mcp.ts` (kilden, ikke en kopi — unngår
dokument-driftklassen denne flåten har rammet før), injiserer ekte
opplevagent.no-data via en mocket `window.openai.getToolOutput()` (samme
kontrakt ChatGPT/Claude faktisk bruker), og skjermbilder resultatet ved
420px CSS-bredde / 3x device-scale (≥1000px PNG-bredde per katalogkravet,
uten å strekke kortet til en bredde det aldri faktisk rendres i — ekte
chat-apper viser disse kortene i en smal kolonne, ikke full skjermbredde).

Kjør på nytt ved kortendringer:
```
node opplevagent-connectors-prep/assets/generate-screenshots.js
```
Krever Playwright + en Chromium-binær (`PLAYWRIGHT_CHROMIUM_PATH` om den ikke
er på standard søkesti).

## Filer
- `01-experiences-list-troms.png`, `04-experiences-list-national-mix.png` —
  `experiences-list`-kortet, to datasett.
- `02-experience-detail-arctic-explorer.png`, `03-experience-detail-aurora-safari.png` —
  `experience-detail`-kortet, to datasett.
- `prompts.txt` — prompt som "produserte" hvert bilde (katalogkrav).
- `generate-screenshots.js` — reproduserbar generator (les fra kilden, ikke en
  hardkodet HTML-kopi).

## Datatroskap — feltparitet mot ekte respons (rettet i uavhengig review)

Mock-dataene i `generate-screenshots.js` speiler nøyaktig feltsettet den ekte
`discover_experiences`/`get_experience`-responsen returnerer — ingen oppdiktede
felt. Én runde fjernet et `slug`-felt fra `experiences-list`-mocken (var
oppdiktet der; `discover_experiences` sin formaterte respons har IKKE `slug`,
kun `get_experience` har det). Dette var usynlig i selve bildet (lenketeksten
er «Les mer ↗», ikke URL-en), men avslørte en ekte, separat produksjonsfeil:
`EXPERIENCES_LIST_HTML`s «Les mer»-lenke leser `e.slug`, så ALLE ekte
`experiences-list`-kort i produksjon lenker i dag til
`.../opplevelse/undefined`. Rutet som egen sak:
`dev-requests/2026-08-24-discover-experiences-list-manglende-slug.md`
(A2A-repoet) — utenfor scope for denne skiven (ingen serverkode endres her).
