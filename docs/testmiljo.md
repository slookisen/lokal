# Testmiljø (lokal kopi med oppdiktede data)

En lokal, kjørbar kopi av hele løsningen (Rett fra Bonden, Opplevagent gårdssalg,
Finn-tannlege) med oppdiktede data — for å se på og klikke gjennom endringer før
de går i prod. Du logger inn som en oppdiktet eier uten e-post, og e-post fanges
i stedet for å sendes.

## Kommandoer

| Kommando | Hva den gjør |
|---|---|
| `npm run testmiljo` | Bygger testdata i `.testmiljo/` hvis en database mangler, og starter appen på port 3100 med innstillingene i `testmiljo.env`. Åpne <http://rettfrabonden.localhost:3100/testmiljo>. Ctrl+C stopper. |
| `npm run testmiljo:nullstill` | Sletter databasene i `.testmiljo/` og bygger dem på nytt (starter ikke appen). |

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
- Oppstarteren fjerner alle arvede miljøvariabler som ser ut som
  hemmeligheter (`…KEY`, `…TOKEN`, `…SECRET`, `…PASS…`, `…PAT`, `SMTP_*`,
  `FLY_*`) før `testmiljo.env` legges på — så LLM-kall, SMTP og betalings-API-er
  er av. Bakgrunnsjobber som går mot nettet eller skriver om data på timer er
  slått av i `testmiljo.env`. Admin-sider svarer «Admin not configured» (ingen
  admin-nøkkel i testmiljøet).
- Koden i `src/testmiljo/` virker bare når `TESTMILJO=1` og miljøet ikke er
  produksjon (`NODE_ENV=production` eller en Fly-variabel). Appen nekter å
  starte med `TESTMILJO` satt i produksjon, med en annen verdi enn `1`, med
  e-postlegitimasjon i miljøet, uten egne databasestier, eller med en `HOST` som
  åpner porten mot nettverket.
- `/testmiljo` svarer bare denne maskinen, bare på de lokale navnene, ikke
  gjennom en tunnel eller mellomtjener, og ikke på skriving fra et annet nettsted.
- Hastighetsgrensene per IP hoppes over i testmiljøet, siden alle lokale kall
  kommer fra 127.0.0.1. `TESTMILJO_RATE_LIMITS=on` beholder dem.

## Filer

- `scripts/testmiljo/seed.ts` — bygger de tre databasene (kan også kjøres
  direkte: `npx tsx scripts/testmiljo/seed.ts [--dir <…/.testmiljo>]`).
- `scripts/testmiljo/launch.ts` — oppstarteren bak npm-kommandoene.
- `testmiljo.env` — innstillingene for testmiljøet (hver linje er forklart).
- `src/testmiljo/` — bryteren (`guard.ts`), oppstartssjekken (`boot.ts`), de
  lokale adressene (`hosts.ts`), sperren for utgående kall (`outbound-guard.ts`),
  e-postfangsten (`outbox.ts`) og sidene under `/testmiljo` (`router.ts`).
- `.claude/launch.json` — lar en Claude Code-økt i repoet starte testmiljøet i
  nettleserruten (oppføringen `testmiljo`).
- `tests/testmiljo.test.ts` — tester (del av `npm test`).
