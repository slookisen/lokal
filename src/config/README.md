# `src/config/` — Vertical-config loader

YAML-bundles under `verticals/<id>/config.yaml` leses ved app-boot,
valideres med Zod, fryses, og caches. Workers ber om typesikker konfig
via `getConfig(verticalId)`.

## Boot-rekkefølge

`loadConfigsAtBoot()` må kalles **før** noen service prøver å lese
config. Se `src/index.ts` for plassering — den ligger først, før DB-init,
fordi `init.ts` kan vokse til å lese vertical-spesifikke ting senere.

## Legge til en ny vertikal

1. `mkdir verticals/<id>/`
2. Skriv `verticals/<id>/config.yaml` (følg `verticals/rfb/config.yaml`)
3. Sørg for at mappenavn = `vertical_id`-felt
4. Restart app — loader plukker opp ved neste boot

## Designvalg

- **Cold-load, ikke hot-reload.** Endringer krever redeploy. Forenkler
  feilhåndtering og eliminerer race conditions. Hvis det blir reell
  smerte, vurder file-watcher i Phase 4.4 — men dokumenter hvorfor.
- **Fail fast at boot.** Malformed YAML eller schema-feil = app refuses
  to start. Bedre enn å silently degrade i prod.
- **Deep-freeze.** Services kan ikke mutere config ved uhell.
- **`JSON_SCHEMA` for js-yaml.** Forhindrer YAML 1.1 sin "Norway problem"
  (NO → false). Verdier som "NO", "YES", "ON", "OFF" beholdes som strings.
- **Env-vars eier KUN secrets.** All business-config lever i YAML. Mixed
  precedence (env overstyrer YAML) er en konsistent kilde til
  uforklarlige bugs.

## Filer

| Fil | Hva |
|---|---|
| `vertical-config.ts` | Schema + loader + `getConfig()` |
| `vertical-config.test.ts` | Unit-tester (Node test-runner) |

## Phase 4-roadmap

- **4.1 (denne):** Loader + RFB-config + 1 proof-of-life-forbruker (`marketplace-registry.ts`)
- **4.2:** Marketing-service leser fra config
- **4.3:** Enrichment, CS, discovery, contact-verifier, visibility — én/dag
- **4.4:** E-post-templates + MCP-tool-descriptions + SEO-routes
- **4.5:** DB `vertical_id`-kolonne + backfill 'rfb'
- **4.6:** Rute-prefiks `/rfb/` parallell + `lookupVerticalByHost` aktiveres
- **4.7:** Smoke-test mot dummy `verticals/test/config.yaml`
