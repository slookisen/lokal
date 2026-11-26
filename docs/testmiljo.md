# Testmiljø (lokal kopi med oppdiktede data)

En lokal, kjørbar kopi av hele løsningen (Rett fra Bonden, Opplevagent gårdssalg,
Finn-tannlege) med oppdiktede data — for å se på og klikke gjennom endringer før
de går i prod. Du logger inn som en oppdiktet eier uten e-post, og e-post fanges
i stedet for å sendes.

## Kommandoer

| Kommando | Hva den gjør |
|---|---|
| `npm run testmiljo` | Bygger testdata i `.testmiljo/` hvis en database mangler, og starter appen på port 3100 med innstillingene i `testmiljo.env`. Åpne <http://rettfrabonden.localhost:3100/testmiljo>. Ctrl+C stopper. |
| `npm run testmiljo:nullstill` | Sletter databasene og de fangede e-postene i `.testmiljo/` og bygger testdataene på nytt (starter ikke appen). Stopp appen først. |
| `npm run testmiljo:lagre -- <navn>` | Lagrer et øyeblikksbilde av databasene. Se «Øyeblikksbilder». |
| `npm run testmiljo:hent -- <navn>` | Setter et lagret øyeblikksbilde tilbake. Stopp appen først. |

Fungerer på Windows og Linux (ren node/tsx, ingen bash). `.testmiljo/` er i
`.gitignore`.

## Adresser

Hver plattform har sitt eget lokale navn. Nettleseren finner dem uten oppsett,
og innloggingen holder seg til navnet du logget inn på.

| Plattform | Adresse |
|---|---|
| Rett fra Bonden | <http://rettfrabonden.localhost:3100> |
| Opplevagent | <http://opplevagent.localhost:3100> |
| Finn-tannlege | <http://finn-tannlege.localhost:3100> |

Lenker og videresendinger som peker til domenene i prod, skrives om til de
lokale navnene. Det dekker vanlige sider og videresendinger, ikke alt: JSON,
statiske filer og adresser som bygges i skript, skrives ikke om. Se på
adresselinjen hvis du er i tvil om hvor du er.

`http://localhost:3100/` gir også Rett fra Bonden, men uten innlogging.

## Logg inn som eier

Åpne `/testmiljo` på plattformens adresse, for eksempel
<http://opplevagent.localhost:3100/testmiljo>. Siden lister eierne som finnes i
testdataene. «Logg inn» lager en vanlig innloggingslenke og følger den, så økten
og alt etterpå er det samme som i prod. Du logger inn på Rett fra Bonden fra
`rettfrabonden.localhost` og på Opplevagent fra `opplevagent.localhost`.

## E-post

Ingen e-post sendes. Alt appen ville sendt, ligger på `/testmiljo/epost`, nyeste
først, med emne, mottaker, innhold og tekstversjon. Lenkene i e-posten peker til
testmiljøet. Listen ligger i `.testmiljo/outbox.jsonl` og tømmes ved nullstilling.

## Utgående kall

Tjeneren får ikke koble til noe utenfor maskinen. Forsøk vises nederst på
`/testmiljo`. Skal noe slippes gjennom, for eksempel en nettside du vil prøve
vareopphenting mot, legger du verten i `TESTMILJO_ALLOW_OUTBOUND` i
`testmiljo.env`. Sperren gjelder hovedprosessen, ikke arbeidertråder.

## Funksjonsflagg (flaggfilen)

Alle funksjonsflagg for testmiljøet settes i én fil: `testmiljo.env` i roten
av repoet. Prod leser den aldri, og testmiljøet leser ikke prod.

- **Regelen:** hvert flagg har verdien det har i prod. Unntaket er
  bakgrunnsjobber som går mot nettet, kaller en språkmodell, sender e-post
  eller skriver om data på timer. De er av her selv om de er på i prod, og hver
  slik linje er merket `# prod: … — off here because …`.
- **Prod-verdien** er bare kjent for flagg som står i `fly.toml` under `[env]`.
  Flagg som ikke står der, er enten ikke satt i prod eller satt som en
  Fly-hemmelighet, som repoet ikke ser. De har kodens standardverdi, skrevet ut.
- **«UNDER TEST»-blokken** nederst slår på det som prøves ut. Nå er det
  eierdashbordene for de oppdiktede eierne: Rett fra Bonden-eierportalen og
  gårdssalg-dashbordet med adresseskjemaet, med
  `OWNER_FEATURES_ALLOWED_SUBJECTS` satt til eiernes faste id-er fra seedingen.
  Du trenger ikke sette noe selv for å se dem.
- **Navn som testen finner:** testen finner bare flagg med de vanlige navnemønstrene
  (`FLAG_NAME_RE` i `src/testmiljo/testmiljo.test.ts`: blant annet `*_ENABLED`,
  `*_DISABLED`, `*_LIVE`, `*_MODE`, `*_SYNC`, `ENABLE_*`, `DISABLE_*`, `SKIP_*`),
  eller flagg som står på `FLAG_FILE_EXTRA_FLAGS` i samme fil. Et flagg med et annet
  navn må legges til på den listen, ellers ser testen det ikke.
- **Når flagget er på i prod:** flytt linjen ut av «UNDER TEST»-blokken til sin
  vanlige plass, med prod-verdien. Ikke slett den: koden leser fortsatt flagget, og
  da feiler testen (f3). Ikke la den stå to ganger: da feiler testen på duplikat (f1).
- **Nytt flagg:** `npm test` feiler hvis koden leser et flagg som ikke står i
  `testmiljo.env`, eller hvis et flagg fra `fly.toml [env]` har en annen verdi
  der uten å stå på unntakslisten i testen (`FLAG_FILE_PROD_EXCEPTIONS` i
  `src/testmiljo/testmiljo.test.ts`, med en grunn). En PR som legger til et
  flagg, legger det også inn i `testmiljo.env`.

## Hva som ligger i testdataene

Alle e-postadresser er på `.invalid`-domener, alle navn er oppdiktet
(«Testgården …», «Testgjest 1» …). Faste id-er; opprettet-tidspunkter er faste,
mens besøks- og hentetider regnes fra dagen seedingen kjører (så «kommende»
forblir kommende).

- **Rett fra Bonden** (`lokal.db`): profil uten eier · profil med ny eier og
  ingen varer · eier med varer og bestillinger (pending, confirmed, ready,
  completed, declined, cancelled) · eier med nettside (`http://localhost/eksempel`)
  · to profiler i en dublettgruppe (samme org.nr.) · låst profil (om-tekst og
  åpningstider låst av kundeservice i `curated_fields`).
- **Opplevagent gårdssalg** (`experiences.db`): produsent uten eier · eier uten
  forespørsler · eier med besøksforespørsler i alle tilstander koden kjenner
  (venter, bekreftet kommende, bekreftet passert, nytt tidspunkt foreslått,
  avslått, utløpt, kansellert, møtt, ikke møtt).
- **Finn-tannlege** (`dental.db`): fire klinikker.

## Sikkerhet

- Seedingen leser aldri fra prod eller nettet. Den bruker appens egen
  skjema-kode (`src/database/init*.ts`), så tabellene er de ekte.
- Den nekter å kjøre (exit ≠ 0) når `NODE_ENV=production`, når `FLY_APP_NAME`
  eller `FLY_MACHINE_ID` er satt, og når en databasesti ligger utenfor en
  `.testmiljo/`-mappe.
- Oppstarteren gir appen bare arvede miljøvariabler på en tillatelsesliste. Det er
  navnene `PATH`, `PATHEXT`, `HOME`, `USER`, `USERNAME`, `LOGNAME`, `SHELL`, `LANG`,
  `LANGUAGE`, `TZ`, `TERM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `TMPDIR`, `TMP`,
  `TEMP`, `SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `USERPROFILE`, `APPDATA`,
  `LOCALAPPDATA`, `PROGRAMDATA`, `PROGRAMFILES`, `PROGRAMFILES(X86)`,
  `COMMONPROGRAMFILES`, `HOMEDRIVE`, `HOMEPATH`, `NUMBER_OF_PROCESSORS`,
  `PROCESSOR_ARCHITECTURE`, `OS`, `NODE_EXTRA_CA_CERTS`, `CI`, `TSX_TSCONFIG_PATH` og
  `TSX_DISABLE_CACHE`, og alle som begynner med `LC_`. Store og små bokstaver spiller
  ingen rolle. Navn som ser ut som hemmeligheter slippes aldri gjennom, selv om
  de skulle stå på listen: et navn med en del som `KEY`, `APIKEY`, `TOKEN`, `SECRET`,
  `PASS`, `PASSWORD`, `PAT` eller `CREDENTIAL(S)`, hvor som helst i navnet, og
  `SMTP_*`, `FLY_*` og `DATABASE_URL`. Alt annet fra skallet når ikke appen. `testmiljo.env`
  legges på etterpå og vinner over en arvet verdi. Et flagg du setter i skallet,
  kommer derfor ikke til appen: endre det i `testmiljo.env` i stedet (i din egen
  kopi, uten å committe den, for en engangstest). LLM-kall, SMTP og betalings-API-er
  er av. Bakgrunnsjobber som går mot nettet eller skriver om data på timer er slått
  av i `testmiljo.env`. Admin-sider svarer «Admin not configured» (ingen admin-nøkkel
  i testmiljøet).
- Koden i `src/testmiljo/` virker bare når `TESTMILJO=1` og miljøet ikke er
  produksjon (`NODE_ENV=production` eller en Fly-variabel). Settes `TESTMILJO`
  i produksjon, ignoreres den, og oppstarten skriver én feillinje i loggen.
  Den stopper ikke appen der.
- Lokalt nekter appen å starte ved feil oppsett: en annen verdi enn `1`,
  e-postlegitimasjon i miljøet, manglende egne databasestier, eller en `HOST`
  som åpner porten mot nettverket.
- `/testmiljo` svarer bare denne maskinen, bare på de lokale navnene, ikke
  gjennom en tunnel eller mellomtjener, og ikke på skriving fra et annet nettsted.
- Ikke publiser port 3100 (ngrok, portvideresending i editoren og lignende).
  Sjekkene over kjenner igjen de vanlige tunnelene, men ikke en som skriver om
  `Host` uten å legge til noe. Bak en slik tunnel ser alle ut som denne maskinen.
- Hastighetsgrensene per IP hoppes over i testmiljøet, siden alle lokale kall
  kommer fra 127.0.0.1. `TESTMILJO_RATE_LIMITS=on` beholder dem.
- Søket slår opp stedsnavn mot Kartverket (`ws.geonorge.no`). Sperren for utgående
  kall stopper det som standard, og forsøket vises nederst på `/testmiljo`. Vil du
  at stedsoppslaget skal virke, legger du `ws.geonorge.no` i
  `TESTMILJO_ALLOW_OUTBOUND` i `testmiljo.env`.
- Handlingstokens og agentnøkler i testdataene er faste, lesbare tekster, for
  eksempel `testmiljo-agent-<n>`, `testmiljo-ordre-<n>`, `testmiljo-claim-<n>` og
  `testmiljo-svar-<tilstand>`. De er oppdiktede og finnes bare i den lokale databasen. De
  er ikke gyldige i prod. Bruk dem aldri andre steder.

## Øyeblikksbilder

Et øyeblikksbilde er en lagret kopi av de tre databasene, slik at du kan komme
tilbake til en tilstand etter at du har klikket rundt.

- `npm run testmiljo:lagre -- <navn>` lagrer `lokal.db`, `dental.db` og
  `experiences.db`, og `outbox.jsonl` hvis den finnes, i
  `.testmiljo/oyeblikk/<navn>/`. Der ligger også `meta.json` med tidspunkt,
  git-commit og antall rader. Lagringen bruker SQLites egen konsistente kopi
  (`VACUUM INTO`), så appen kan gå mens du lagrer.
- `npm run testmiljo:hent -- <navn>` setter bildet tilbake. Appen må være stoppet.
  Finnes det en `-wal`-, `-shm`- eller `-journal`-fil ved en av databasene, nekter
  kommandoen og ber deg stoppe appen. Hver fil byttes atomisk for seg, ikke alle tre
  samlet. Stopper det midtveis, melder kommandoen hvilke filer som er hentet.
  Kjør `hent` på nytt. Har bildet ingen `outbox.jsonl`, slettes den fangede
  e-postlisten.
- Uten navn skriver begge kommandoene ut bildene som finnes og avslutter med feil.
- Navnet kan bare ha små bokstaver a–z, tall og bindestrek, ikke bindestrek først,
  og maks 40 tegn. Windows-reserverte navn nektes: `con`, `prn`, `aux`, `nul`,
  `com1`–`com9` og `lpt1`–`lpt9`.
- Lagrer du med et navn som finnes, erstattes det gamle bildet, men først når det
  nye er ferdig.
- Kommandoene nekter å kjøre i prod (samme sperre som seedingen), og ingen sti
  under `.testmiljo/oyeblikk` kan være en symlenke.

## Filer

- `scripts/testmiljo/seed.ts` — bygger de tre databasene (kan også kjøres
  direkte: `npx tsx scripts/testmiljo/seed.ts [--dir <…/.testmiljo>]`).
- `scripts/testmiljo/launch.ts` — oppstarteren bak npm-kommandoene.
- `scripts/testmiljo/snapshot.ts` — øyeblikksbildene (`testmiljo:lagre`, `testmiljo:hent`).
- `testmiljo.env` — innstillingene for testmiljøet (hver linje er forklart).
- `src/testmiljo/` — bryteren (`guard.ts`), oppstartssjekken (`boot.ts`), de
  lokale adressene (`hosts.ts`), sperren for utgående kall (`outbound-guard.ts`),
  e-postfangsten (`outbox.ts`) og sidene under `/testmiljo` (`router.ts`).
- `.claude/launch.json` — lar en Claude Code-økt i repoet starte testmiljøet i
  nettleserruten (oppføringen `testmiljo`).
- `tests/testmiljo.test.ts` — tester (del av `npm test`).
