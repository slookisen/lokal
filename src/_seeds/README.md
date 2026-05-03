# `src/_seeds/` — historiske seed-skript

Disse filene er ekskludert fra TypeScript-kompilering (`tsconfig.json` "exclude") og kjøres **ikke** automatisk. De er bevart som audit-trail for hvordan databasen ble seedet opprinnelig.

## Innhold

| Fil | Status | Hva |
|---|---|---|
| `seed-knowledge.ts` | Aktivt brukt — lazy-loaded fra `src/index.ts` hvis DB er tom | Initial knowledge-seed |
| `seed-marketplace.ts` | Historisk | Marketplace-seed (kjørt én gang) |
| `seed-norway-expansion.ts` | Historisk | Norge-utvidelse (kjørt én gang) |
| `seed-expansion-v2.ts`-`seed-expansion-v8.ts` | Historisk | Inkrementelle ekspansjoner |
| `seed-oslo-real.ts` | Historisk | Oslo-spesifikk seed |

## Hvorfor beholde

Hvis vi noen gang trenger å re-bygge databasen fra scratch, vil disse skriptene gi en startverdi (men data er nå mest dynamisk via discovery + enrichment-agentene).

## Hvorfor ekskludere fra build

`tsconfig.json` har `"exclude": ["src/_seeds", ...]` så de tar ikke plass i `dist/`-bygget eller TypeScript-kompileringen. De er kun kildefiler for arkivering.

## Hvis du må kjøre én

```bash
npx tsx src/_seeds/seed-norway-expansion.ts
```

NB: Sjekk at den ikke bryter eksisterende rader. Mest av disse skriptene gjør INSERT OR IGNORE.
