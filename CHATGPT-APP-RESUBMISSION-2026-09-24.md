# ChatGPT-app: ny innsending etter avvisningene 24.09.2026

Gjelder **Rett fra Bonden** (v1.0.1 avvist) og **Opplevagent** (v1.0.0 avvist).
Importfilene til innsendingsskjemaet ligger ved siden av dette dokumentet:
`chatgpt-app-submission.json` (RFB) og `opplevagent-chatgpt-app-submission.json`.
Begge validerer mot OpenAIs skjema
`https://developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json`.

## 0. Oppdatering 03.10.2026 (les dette først)

Det har ikke kommet noen ny avvisning siden 24.09, og ingen av appene er sendt inn på nytt. Før innsending ble alt kjørt på nytt mot produksjon. Testcasene ble i tillegg kjørt med flere varianter av argumentene ChatGPT kan finne på å sende. Det avdekket disse svakhetene, som nå er rettet:

**Opplevagent**
- Kategorien ble ignorert hvis modellen skrev den slik den vises for brukeren («wildlife & safari») eller fant på en slug («wildlife_safari»). Da viste listen alle kategorier, og testcase 4 lover bare dyreliv. Nå mappes ordene til riktig slug. En ukjent kategori gir en melding med gyldige verdier i stedet for å forsvinne stille.
- Kommune med liten forbokstav («tromsø») ble ignorert, og da kom treff fra hele landet. Nå spiller store og små bokstaver ingen rolle.
- `discover_gardssalg` ga null treff for «vestland» (liten forbokstav), «Hordaland» og fritekst som «gårdssalg Vestland». Det gjelder testcase 5. Alle tre gir nå Vestland-produsentene.
- Verktøybeskrivelsen sier nå uttrykkelig at «om vinteren» er `season`, ikke kategorien `vinter_sno`. Med kategori forsvant nordlyscruiset og Aurora Safari Camp fra testcase 1.

**Rett fra Bonden**
- Testcase 1 er byttet fra «ost nær Bergen» til «reinsdyrkjøtt i Finnmark». Ostelista fikk med bakerier, fisketorgboder og en birøkter som er merket med meieri i dataene. En vurderer kunne underkjenne det.
- Søket kjente ikke igjen «reinsdyrkjøtt» og «reinkjøtt». Da kom alle produsenter i Finnmark, med et bryggeri og et bakeri først. Ordene er nå lagt til.
- `lokal_cart_submit` har fått valgfrie felt for kjøperens kontaktinfo og sender bare ekte bestillinger til verifiserte produsenter som har takket ja til bestillinger via plattformen. Begrunnelsen i importfila og personvernsiden (rettfrabonden.com/personvern) er oppdatert. Kontaktinfo deles bare med samtykke.
- Forventet resultat i casene sier nå også at utvalg og rekkefølge kan endre seg.

**Begge appene: negative testcaser**
- Hvis ChatGPT likevel kalte verktøyet ved «pizza i Roma» eller «safarilodge i Kenya», svarte appene med norske treff. «Rome» traff Romeriksmat på Jessheim, og «Kenya» ble løsnet bort til en landsdekkende liste. Forventet oppførsel i begge casene er at appen *ikke* gir norske treff. Nå svarer verktøyene at de bare dekker Norge når et kjent utenlandsk sted (land eller storby) eller koordinater utenfor Norge er med i søket.

Alt er låst med tester: `opplevagent-chatgpt-review.test.ts`, `rfb-chatgpt-annotations.test.ts`, `marketplace-search-english-queries.test.ts` og `rfb-privacy-terms-truth.test.ts`.

## 0b. Etter ChatGPTs uavhengige gjennomgang (03.10.2026, runde 2)

ChatGPT gjennomgikk pakken og fant disse problemene. De er nå rettet i koden:

- **`lokal_discover` ignorerte koordinatene.** En radius på 30 km rundt Roma og 1 km rundt Oslo ga samme landsdekkende liste. Nå brukes lat/lng og radius, halve eller ugyldige koordinater avvises, og koordinater utenfor Norge gir svaret «dekker bare Norge».
- **Navnesøket feilet ofte.** «Ostegarden Bergen» og hele spørsmålet i testcase 4 fant ikke Ostegården. Nå finnes en produsent som nevnes ved navn, uansett omkringliggende ord og skrivemåte (å/a, ø/o, æ/ae). Engelsk «and» tolkes heller ikke lenger som fuglen «and» (kjøtt).
- **Produsenter uten produktet rangerte for høyt.** Produsenter der produktlista nevner det som søkes på, kommer nå først. Produsenter som bare er med fordi de har riktig kategori, får merknaden «Kategoritreff: produktlista nevner ikke …».
- **Personvern for Rett fra Bonden motsa seg selv.** Siden sa både «ingen automatisk utløp» og «60 dager». Nå står det det koden faktisk gjør: rå besøks-, søke- og MCP-logger slettes automatisk etter 60 dager, og bare daglige tall uten kobling til personer beholdes.
- **Personvern og vilkår for Opplevagent var upresise.**
  - Påstanden om «opptil 180 dager» hadde ingen dekning i koden og er fjernet.
  - Siden sier nå rett ut at besøksforespørsler ikke slettes automatisk, og at de slettes innen 30 dager når noen ber om det.
  - Vilkårene har fått et eget avsnitt om besøksforespørsler.
- **Innsendingsfila for Rett fra Bonden:**
  - Testcase 4 bruker bare `lokal_search`.
  - Forventet resultat beskriver nå rangering og merking av kategoritreff, og påstår ikke at honningen er «rå».
  - App-beskrivelsen er nedtonet til det som kan dokumenteres.

**Dette må du avgjøre selv (ikke kode):**
- **Utgiver.** Hvis appene skal sendes inn som agentplatform.no AS, må selskapet være registrert og verifisert hos OpenAI først. Navnet på personvern- og vilkårssidene («Operatør: Daniel Fredriksen») må da også endres. Inntil det er på plass, send inn som privatperson, slik som før. Last ikke opp stiftelsesdokumentet: det inneholder fødselsnummer.
- **`CART_CONTACT_SWEEP_LIVE`.** Personvernsiden for Rett fra Bonden lover at kjøpers kontaktinfo slettes automatisk etter 30 dager. Sletteknappen står i prøvemodus til denne Fly-hemmeligheten er satt til `true`. Sjekk loggen `[cart-contact-sweep]` og slå den på.
- **Datafeil i katalogen:**
  - «Snill Bie — Bømlo» har adresse på Fåberg.
  - «Myrvold Gård — Huglo» har adresse i Jordet.
  - «Voll Gård — Stavanger» har Trondheim-adresse.
  - Det Franske Bakeri, Søtt+Salt Bakeri og Tresselts Birøkt er feilmerket med meieri.

## 1. Hvorfor appene ble avvist

### Rett fra Bonden: annotasjonene stemte ikke med oppførselen

OpenAI definerer hintene slik (developers.openai.com/plugins/deploy/submission og /deploy/app-review):

- **openWorldHint** = true når verktøyet «accesses the public internet … including
  read-only tools such as web search».
- **destructiveHint** = true når et skriveverktøy kan «delete, overwrite … send messages
  or transactions that can't be undone».

Tre av RFB-verktøyene brøt med disse definisjonene:

| Verktøy | v1.0.1 | Faktisk oppførsel | Nå |
|---|---|---|---|
| `lokal_geocode`, `lokal_search`, `lokal_find_offers` | openWorld **false**. Begrunnelsen sa «own gazetteer». | Stedsnavn som ikke finnes lokalt slås opp i Kartverkets offentlige API (ws.geonorge.no). Beskrivelsen av `lokal_geocode` sa dette allerede. | openWorld **true** |
| `lokal_cart_submit` | destructive **false** («orders can be cancelled») | Lukker handlekurven og sender e-post til produsenter. En sendt e-post kan ikke trekkes tilbake. | destructive **true** |
| `lokal_cart_add_item` | destructive **false**, idempotent **false** | Hvis varen ligger i kurven fra før, overskrives antallet og notatet. Samme kall to ganger gir samme kurv. | destructive **true**, idempotent **true** |

Alle leseverktøy har nå `idempotentHint: true`. Tidligere var `lokal_search` og `lokal_discover` satt til false.

### Opplevagent: testcasene ga feil resultat

Alle feilene under er reprodusert mot produksjon 24.09:

1. **Kortene (widgetene) var tomme i ChatGPT.**
   - Malene leste data via `window.openai.getToolOutput()`, en funksjon ChatGPT aldri har hatt. Den fantes bare i mocken i vår egen skjermbildegenerator.
   - Verktøyene returnerte heller ikke `structuredContent`.
   - Resultatet var at listekortet viste «Ingen opplevelser funnet.» mens ChatGPT listet opplevelser i teksten, og detaljkortet var tomt.
   - Testcase 1 og 2 lovet begge et kort.
2. **Sesongfilteret traff bare én skrivemåte.** Dataene blander «winter»/«vinter», «autumn»/«host», «all_year» og så videre. Derfor falt blant annet Aurora Safari Camp ut av «Troms om vinteren».
3. **Dataene hadde endret seg siden 09.09.**
   - Kategoritallene hadde gått *ned* (kultur 162 → 142), mens forventet tekst sa at de bare stiger.
   - Amble Gård er borte fra Vestland.
   - Skibotn-campingen er nå merket som sommeraktivitet.
4. Parameterbeskrivelsen for `category` foreslo slug-en `'vinter'`, som ikke finnes. Den riktige er `vinter_sno`.

## 2. Hva som er fikset i koden (PR i slookisen/lokal)

- **Opplevagent-widgetene** (`src/routes/opplevagent-widgets.ts`) er skrevet om etter MCP Apps-standarden som ChatGPT bruker nå:
  - De serveres som `text/html;profile=mcp-app` med `_meta.ui.domain` (påkrevd ved innsending med UI) og CSP.
  - De gjør `ui/initialize`-håndtrykket og leser `ui/notifications/tool-result`, med `window.openai.toolOutput` som reserve.
  - Lenker åpnes via verten (`openExternal` / `ui/open-link`).
  - De støtter mørk modus og mobilbredde, og all data HTML-escapes.
  - `discover_experiences` og `get_experience` returnerer nå `structuredContent`.
  - Kortene er verifisert i Chromium med begge brotypene, der dataene kommer sent slik de gjør på mobil.
- **Sesongfilteret** (`experience-store.ts`) matcher alle skrivemåter på norsk og engelsk, og tar med helårsaktiviteter.
- **Kategori:** beskrivelsen lister de ni ekte slug-ene, og vanlige ord («vinter», «wildlife» osv.) mappes til riktig slug.
- **Annotasjonene** er rettet i `src/routes/mcp.ts` (RFB) og `src/routes/experiences-mcp.ts`:
  - Opplevagents tre leseverktøy er nå closed-world. De leser bare egen database, og «lenker ut» gjør ikke et verktøy open-world.
  - `book_gardssalg` er nå destructive, siden den sender e-post til produsent og gjest.
- **Personvern:**
  - opplevagent.no/personvern beskriver nå besøksforespørsler til gårdssalg: navn, e-post, telefon og merknad, som deles med produsenten.
  - rettfrabonden.com/personvern beskriver hentebestillinger.
  - «Udokumenterte persondata i svar» er en egen avvisningsgrunn hos OpenAI.
- **Tester som låser dette:**
  - `src/routes/rfb-chatgpt-annotations.test.ts` og `src/routes/opplevagent-chatgpt-review.test.ts` låser hele annotasjonstabellen.
  - De sjekker også at innsendingsfilene har nøyaktig de samme verdiene som serveren.
  - I tillegg dekker de widget-broen, sesong- og kategorifiksene.

## 3. Slik sender du inn på nytt (rekkefølgen er viktig)

1. **Merge PR-en og vent til den er deployet** (fly-deploy). Kontroller at `https://opplevagent.no/mcp` → `resources/read` for `ui://opplevagent/experiences-list` gir `mimeType: text/html;profile=mcp-app`.
2. **Vent minst én time.** ChatGPT kan cache gamle widget-ressurser i opptil en time.
3. **Test selv i ChatGPT developer mode, både på web og i mobilappen** (iOS eller Android). Kjør alle fem testcasene for hver app i en *ny* samtale.
   - Opplevagent-kortene skal vise opplevelser, ikke «Ingen opplevelser».
   - Knappene «Detaljer» og «opplevagent.no ↗» skal virke.
   - OpenAI godtar ikke Chrome DevTools-mobilsimulering som mobiltest.
4. **I portalen: åpne appen, lag ny versjon og kjør «Scan Tools»** på nytt. Kontroller at hintene som ble skannet, er de samme som i tabellene under. Begrunnelsene overstyrer *ikke* det serveren annonserer; det er de skannede verdiene som vurderes.
5. **Importer JSON-filen** for appen. Den fyller ut begrunnelser, 5 positive og 3 negative testcaser, og release notes (feltet `release_notes`, lim inn hvis skjemaet ikke tar det fra fila).
6. **Spill inn ny demovideo** som viser hovedflyten på *både* web og mobil. OpenAI flagger videoer fra bare én plattform. For Opplevagent må kortene synes i videoen. Ikke fullfør `book_gardssalg` eller `lokal_cart_submit` mot en ekte produsent i videoen.
7. **Send inn.** Hvis en ny avvisning er uklar, kan du svare direkte på avvisningsmailen og spørre hvilket verktøy eller testcase det gjelder. OpenAI oppgir dette som offisiell kanal.

## 4. Annotasjonstabeller (det serveren annonserer nå)

**Rett fra Bonden**

| Verktøy | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| lokal_search | ✔ | – | ✔ | ✔ (Kartverket) |
| lokal_discover | ✔ | – | ✔ | – |
| lokal_info | ✔ | – | ✔ | – |
| lokal_stats | ✔ | – | ✔ | – |
| lokal_list_umbrellas | ✔ | – | ✔ | – |
| lokal_get_umbrella_members | ✔ | – | ✔ | – |
| lokal_get_producer_affiliations | ✔ | – | ✔ | – |
| lokal_bm_next_markets | ✔ | – | ✔ | – |
| lokal_geocode | ✔ | – | ✔ | ✔ (Kartverket) |
| lokal_find_offers *(ny siden v1.0.1)* | ✔ | – | ✔ | ✔ (Kartverket) |
| lokal_cart_create | – | – | – | – |
| lokal_cart_add_item | – | ✔ (overskriver antall) | ✔ | – |
| lokal_cart_view | ✔ | – | ✔ | – |
| lokal_cart_submit | – | ✔ (e-post kan ikke angres) | – | ✔ (e-post til produsent) |
| lokal_order_status | ✔ | – | ✔ | – |

**Opplevagent**

| Verktøy | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| discover_experiences | ✔ | – | ✔ | – |
| list_experience_categories | ✔ | – | ✔ | – |
| get_experience | ✔ | – | ✔ | – |
| discover_gardssalg | ✔ | – | ✔ | – |
| book_gardssalg | – | ✔ (e-post kan ikke angres) | – | ✔ (e-post til produsent og gjest) |

## 5. Testcasene

Alle testcasene er skrevet som *form på resultatet + noen stabile eksempler*, ikke eksakte tall eller rekkefølge. Da tåler de at katalogen endrer seg mellom innsending og vurdering. RFB-casene er kjørt mot produksjon 24.09. Opplevagent-casene forutsetter at PR-en er deployet, siden sesongfiksen og kortene trengs.

- **RFB:**
  - reinsdyrkjøtt i Finnmark (byttet ut ost nær Bergen 03.10)
  - rå honning i Vestfold
  - lam i Innlandet
  - Ostegården (navnesøk)
  - tørrfisk i Lofoten

  «eggs Rogaland» er byttet ut fordi den ga en kombuchabutikk og en fiskebutikk, og «Voll Gård — Stavanger» med Trondheim-adresse.
- **Opplevagent:**
  - Troms om vinteren (listekort)
  - Arctic Explorer-detaljer (detaljkort)
  - kategorioversikt
  - dyreliv- og safariopplevelser
  - gårdssalg i Vestland
- **Negative (begge):** betaling i chatten, utenfor Norge, og masseutsending / å bekrefte uten produsenten.

## 6. Verdt å vite

- `lokal_find_offers` ligger på live-serveren, men var ikke med i v1.0.1. Den blir med i neste skanning og har fått rad og begrunnelse i importfila.
- Opplevagent er merket `commerce_enabled`, men selger ingenting selv og lenker ut til tilbyderne. OpenAI godkjenner i dag bare handel med fysiske varer. Var ikke avvisningsgrunn, men vurder å svare «nei» på handelsspørsmålet for Opplevagent hvis skjemaet spør.
- Datafunn som ikke er rettet i denne PR-en (kan dukke opp for en vurderer):
  - «Voll Gård — Stavanger» har Trondheim-adresse.
  - Hansa Borg (industribryggeri) ligger i gårdssalg-lista.
  - Fjellheisen har varighet 1440 min.
  - Sesongverdier skrives fortsatt på to språk når data legges inn. Filteret tåler det nå, men kilden er ikke ryddet.
