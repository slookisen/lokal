# `verticals/` — Vertikal-konfig (data, ikke kode)

Hver undermappe representerer én vertikal (et marked / domene plattformen
betjener). Kjernen i `src/` er domeneuavhengig; alt RFB-spesifikt lever
her som data.

## Filer pr vertikal

```
verticals/<id>/
  config.yaml      # domene-ordbok, agent-konfig, connectors
```

## Aktive vertikaler

| ID | Navn | Domene | Status |
|---|---|---|---|
| `rfb` | Rett fra Bonden | rettfrabonden.com | Live siden 2026-04-13 |
| `test` | Test Vertical | example.test | Test-fixture (alle agenter `enabled: false`) |

## Legge til en ny vertikal

Se `src/config/README.md`. Phase 4 mål: en ny vertikal skal ikke kreve
endringer i `src/services/`. Hvis du må endre kode for å onboarde en
vertikal, har Phase 4-refaktoren et hull — flag det i en issue.

## Schema

Validert av `src/config/vertical-config.ts` (Zod). Schema-endringer skal
være additive (nye optional-felt) inntil videre, så eksisterende vertikaler
ikke brekker ved deploy.
