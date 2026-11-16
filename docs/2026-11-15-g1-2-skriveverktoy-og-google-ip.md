# G1-2 — skriveverktøy og Google-IP-områder (2026-11-15)

Dev-request: `2026-11-12-g1-google-klar`, skive G1-2 (L3). Rapporten ligger i
`docs/` fordi lokal ikke har noen `reports/`-mappe.

Ingen verktøyannotasjon eller verktøytekst er endret i denne skiven: `tools/list`
på RFB-serveren (`src/routes/mcp.ts`) og Opplevagent-serveren
(`src/routes/experiences-mcp.ts`) er uendret. Feil merking er bare notert her, som
funn til kontraktvinduet F1-2.

## 1. Hva Google sier (lest 2026-11-15)

Kilder:

| URL | Hva siden sier |
|---|---|
| https://developers.google.com/connected-apps/gpc/prerequisites | «If your server restricts external access by source IP, allowlist the following IP addresses»: `108.177.64.0/20`, `142.250.88.0/22`, `172.217.80.0/20`, `192.178.20.0/22`, `192.179.0.0/20`, `74.125.232.0/24`, `136.121.40.0/21`. Videre: «Google's outbound IP ranges can change over time, so we recommend reading them from Google's published lists», med lenke til `user-triggered-fetchers-google.json` og `user-triggered-agents.json`. |
| https://developers.google.com/connected-apps/mcp/server-optimization | Samme sju CIDR-blokker («allowlist the following Google outbound CIDR blocks», HTTPS port 443). Krav til annotasjoner: `destructiveHint: true` på «state-changing, write, or destructive actions», `readOnlyHint: true` på rene spørreverktøy, `openWorldHint: true` på verktøy som når eksterne miljøer. Overflaten «natively prompts the user for confirmation prior to execution» med `destructiveHint: true` og `openWorldHint: true` som nøkkelflagg. Mangler `readOnlyHint`, antar klienten `readOnlyHint: false` og `destructiveHint: true`. Feilkode `-32300 USER_RATE_LIMITED`. |
| https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers | `Google-Agent` («agents hosted on Google infrastructure to navigate the web and act on user request») bruker IP-områdene i `user-triggered-agents.json`. Ingen egen «Gemini»-henter utover Gemini Notebook. |
| https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot | Lister alle JSON-filene (common-crawlers, special-crawlers, user-triggered-fetchers, user-triggered-fetchers-google, user-triggered-agents) og `goog.json` for «other Google IP addresses». |
| https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json | creationTime `2026-11-13T15:45:59`, 20 prefikser (12 IPv4, 8 IPv6). |
| https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json | creationTime `2026-11-13T15:46:01`, 504 prefikser (252 IPv4 /27, 252 IPv6 /64). |
| https://www.gstatic.com/ipranges/goog.json | 148 prefikser, hele Googles adresserom. |

Konklusjon: Google publiserer ingen liste merket «Gemini». Det nærmeste og mest
forsvarlige er Connected Apps-plattformen (MCP-serverne som vises i Google-produkter):
de sju CIDR-blokkene den lister, pluss `user-triggered-agents.json` (Google-Agent),
som samme side peker til. Disse 27 oppføringene (noen overlapper) ligger statisk i
`src/middleware/google-ip-ranges.ts` med kilde og dato i toppkommentaren.

Utelatt med vilje:
- `user-triggered-fetchers-google.json` (504 prefikser): Googles andre henter
  (Feedfetcher, Site Verifier, Messages …), ikke dokumentert som MCP-kallere. Kan
  legges til senere hvis Gemini-trafikk viser seg å komme derfra; uten den blir
  slike kall telt per IP som i dag.
- `goog.json`: hele Googles adresserom, inkludert Google Cloud-kunders utgående
  trafikk. Da ville vilkårlige skykunder dele Google-bøtta.

Ingen henting ved kjøretid. Listen må oppdateres som en kodeendring med ny dato.

## 2. Hastighetsgrense — design

`src/middleware/mcp-rate-limit.ts`, bak `MCP_RATE_LIMIT_GOOGLE_RANGES_ENABLED`
(av som standard; bare nøyaktig strengen `"true"` slår det på, lest per forespørsel).

- Flagg av: samme nøkler, grenser og headere som før.
- Flagg på, klient-IP (`req.ip`, uendret logikk fra `client-ip.ts`) i Googles
  områder: overalt der en grense ellers bruker IP-en, brukes én felles nøkkel
  `google-ranges`:
  - brems (brake): `google-ranges` i stedet for IP
  - primær: IP-reserven blir `ip:google-ranges`; en levende økt (`sid:`) eller en
    gjenkjent nøkkel (`key:`) vinner fortsatt
  - sideeffekt: Opplevagents `book_gardssalg` bruker `google-ranges`; RFB-handlekurven
    bruker `google-ranges:<buyer_ref>` (uten buyer_ref: `google-ranges`)
- Den felles bøtta får `GOOGLE_RANGES_LIMIT_MULTIPLIER` (10) × grensens egen grense:
  brems 30 000 / 15 min, primær 2 000 / 15 min, sideeffekt 200 / min. Nøkler per økt,
  per nøkkel og per buyer_ref beholder vanlig grense. Ingen env-overstyring av grensene
  (de eksisterende grensene har ingen).
- Kall fra Google-områdene telles ikke i noen bøtte per IP.

## 3. Skriveverktøy

Kolonnene: R = readOnlyHint, D = destructiveHint, I = idempotentHint, O = openWorldHint.
«Bekreftelse» betyr: krever verktøyet (eller beskrivelsen) brukerens bekreftelse før
det handler? Ingen av verktøyene håndhever bekreftelse på serveren (ingen
bekreftelsesparameter eller to-stegs-flyt); det som finnes er instrukser til
assistenten i beskrivelsen, og klientens egen bekreftelse styrt av annotasjonene.

### RFB (`src/routes/mcp.ts`)

| Verktøy | R / D / I / O | Riktig merking? | Bekreftelse |
|---|---|---|---|
| `lokal_cart_create` | false / false / false / false | Riktig etter MCP-spesifikasjonen (lager ny, overskriver ingenting, ingen tredjepart). Men Googles regel krever `destructiveHint: true` på alle «write» → **avvik mot Google**. | Nei. Lavrisiko: bare en tom anonym kurv. |
| `lokal_cart_add_item` | false / true / true / false | Riktig (upsert overskriver linjen; samme kall to ganger gir samme kurv). | Nei. |
| `lokal_cart_submit` | false / true / false / true | Riktig (sender e-post til produsent, kan ikke angres). | Bare i beskrivelsen og bare når `PAYMENTS_ENABLED` er på («get the buyer's explicit go-ahead before calling»). **Med betaling av (dagens standard) står det ingen bekreftelsesinstruks** → funn. D+O=true gjør at Googles overflate ber om bekreftelse. |
| `lokal_order_cancel` (kun med `ORDER_AGENT_ACTIONS_ENABLED`) | false / true / true / true | Riktig. | Ja i beskrivelsen («Only call this tool when the user has explicitly told you …»), og `expected_action`-sjekk. |
| `lokal_order_picked_up` (kun med `ORDER_AGENT_ACTIONS_ENABLED`) | false / true / true / false | Riktig etter MCP-spesifikasjonen (ingen tredjepart). Hvis Google krever både D og O for å be om bekreftelse, får dette verktøyet ingen bekreftelse fra Googles overflate → **avklares i F1-2**. | Ja i beskrivelsen. |
| `lokal_order_message` (kun med `ORDER_AGENT_ACTIONS_ENABLED` + `ORDER_MESSAGES_ENABLED`) | false / false / false / true | Etter MCP-spesifikasjonen forsvarlig (legger til, overskriver ingenting). Men den sender e-post til en tredjepart som ikke kan kalles tilbake — samme begrunnelse som gjorde `lokal_cart_submit` og `book_gardssalg` destruktive. Etter Googles regel skal den ha `destructiveHint: true` → **feil/inkonsistent**. | Delvis («Only send what the user has asked you to send»). |

### Opplevagent (`src/routes/experiences-mcp.ts`)

| Verktøy | R / D / I / O | Riktig merking? | Bekreftelse |
|---|---|---|---|
| `book_gardssalg` | false / true / false / true | Riktig (e-post til produsent og gjest, kan ikke kalles tilbake). | Ingen eksplisitt instruks om å få gjestens ja før kallet; beskrivelsen ber bare om å lese produsent og tidspunkt tilbake *etter* suksess, og om å spørre etter navn/e-post. D+O=true gjør at Googles overflate ber om bekreftelse. **Funn: legg til en «spør gjesten før du sender»-setning i F1-2.** |

### Leseverktøy

Alle leseverktøy er merket `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`: RFB `lokal_search`, `lokal_discover`, `lokal_info`,
`lokal_stats`, `lokal_list_umbrellas`, `lokal_get_umbrella_members`,
`lokal_get_producer_affiliations`, `lokal_bm_next_markets`, `lokal_geocode`,
`lokal_find_offers`, `lokal_cart_view`, `lokal_order_status`; Opplevagent
`discover_experiences`, `list_experience_categories`, `get_experience`,
`discover_gardssalg`. `openWorldHint: true` bare på de tre som kan spørre Kartverket
(`lokal_search`, `lokal_geocode`, `lokal_find_offers`). Ingen ser feil ut. Alle
verktøy har eksplisitte annotasjoner, slik Google anbefaler.

## 4. Tester

- `src/middleware/mcp-rate-limit.test.ts`: CIDR-matcher (grenser, IPv6,
  IPv4-mappet IPv6, søppel → false), flagg kun på `"true"`, AK2 (flagg av: en
  Google-adresse begrenses per IP som før, Google-bøtta brukes aldri), AK3 (flagg på:
  to ulike Google-IPv4 og én IPv6 teller ned én felles teller med egen grense; en
  ikke-Google-adresse er fortsatt per IP; sideeffekt-kall telles i Google-bøtta).
- Full suite og `tsc --noEmit` grønne (tall i PR-beskrivelsen).

## FUNN TIL OPPFØLGING

- [FUNN] `lokal_cart_submit` har ingen instruks om å få kjøperens ja før kallet når `PAYMENTS_ENABLED` er av (dagens standard); instruksen finnes bare i betalingsvarianten. Forslag til F1-2.
- [FUNN] `book_gardssalg` har ingen eksplisitt instruks om å få gjestens ja før forespørselen sendes. Forslag til F1-2.
- [FUNN] `lokal_order_message` er `destructiveHint: false`, men sender e-post til produsenten som ikke kan kalles tilbake; inkonsistent med `lokal_cart_submit`/`book_gardssalg` og med Googles regel («state-changing, write» → `destructiveHint: true`). Forslag til F1-2.
- [FUNN] `lokal_cart_create` (og `lokal_order_picked_up` for bekreftelsesflyten) følger MCP-spesifikasjonen, men ikke Googles strengere regel for skriveverktøy. Avklar i F1-2 om én felles merking skal tilpasses Google uten å bryte ChatGPT-gjennomgangen.
- [FUNN] Google publiserer ingen Gemini-spesifikk IP-liste; Google-listen i `google-ip-ranges.ts` er statisk og må oppdateres manuelt (Google sier at områdene endrer seg). Vurder en periodisk sjekk mot de to JSON-filene.
- [FUNN] Google returnerer egen feilkode `-32300 USER_RATE_LIMITED`; våre 429-svar bruker `-32000`. Vurder i F1-2 om koden skal følge Google.
