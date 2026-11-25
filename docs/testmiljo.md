# Testmiljø (lokal kopi med oppdiktede data)

En lokal, kjørbar kopi av hele løsningen (Rett fra Bonden, Opplevagent gårdssalg,
Finn-tannlege) med oppdiktede data — for å se på og klikke gjennom endringer før
de går i prod. Slice 1: frødata + oppstart. Ingen innlogging som testeier ennå.

## Kommandoer

| Kommando | Hva den gjør |
|---|---|
| `npm run testmiljo` | Bygger testdata i `.testmiljo/` hvis en database mangler, og starter appen på <http://localhost:3100> med innstillingene i `testmiljo.env`. Ctrl+C stopper. |
| `npm run testmiljo:nullstill` | Sletter databasene i `.testmiljo/` og bygger dem på nytt (starter ikke appen). |

Fungerer på Windows og Linux (ren node/tsx, ingen bash). `.testmiljo/` er i
`.gitignore`.

## Domener

Appen velger nettsted etter `Host`-headeren. Uten egen domene-ruting (ikke i
denne slicen) når du de to andre nettstedene med en Host-header, f.eks.:

```
curl -H "Host: opplevagent.no" http://localhost:3100/kategori/gardssalg
curl -H "Host: finn-tannlege.com" http://localhost:3100/
```

`http://localhost:3100/` gir Rett fra Bonden.

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

## Filer

- `scripts/testmiljo/seed.ts` — bygger de tre databasene (kan også kjøres
  direkte: `npx tsx scripts/testmiljo/seed.ts [--dir <…/.testmiljo>]`).
- `scripts/testmiljo/launch.ts` — oppstarteren bak npm-kommandoene.
- `testmiljo.env` — innstillingene for testmiljøet (hver linje er forklart).
- `tests/testmiljo.test.ts` — tester (del av `npm test`).
