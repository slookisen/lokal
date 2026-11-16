# G1-3: Skjemasjekk for nettleseragenter (2026-11-16)

**Mål:** En agent som styrer en nettleser for en kjøper eller gjest (for eksempel en
Gemini-agent eller en assistent med nettleser) skal kunne fylle ut våre to offentlige
skjema uten å gjette. Agenten finner feltene via etiketter (`<label>`), feltnavn,
`type` og `autocomplete`. Denne sjekken går gjennom alle felt i de to skjemaene.

**Hva vi endret:** Bare attributter (`autocomplete`, `inputmode`, `aria-describedby`).
Ingen synlig tekst er endret: ingen ordlyd, ingen nye etiketter og ingen ny knappetekst.
Feltnavn som serveren leser, og validering på serveren, er uendret.
Testen `src/routes/forms-browser-agent-g1-3.test.ts` sammenligner den synlige teksten i
begge skjemaene med et øyeblikksbilde hentet fra `origin/main` før endringen.

## Skjemaene vi valgte

| Tjeneste | Skjema | Fil | Rute |
|---|---|---|---|
| Rett fra Bonden | Handleliste / bestilling (kjøperen velger produsent per vare og sender henteordre) | `src/routes/handleliste-page.ts` (rendres av `src/routes/seo.ts`) | `GET /handleliste` (NO), `GET /en/shopping-list` (EN). Krever `HANDLELISTE_ENABLED`. |
| Opplevagent | Forespørsel om besøk på gårdssalg (nettversjonen av `book_gardssalg`) | `src/routes/experiences-seo.ts` | `GET /kategori/gardssalg/book/:slug` (skjemaet vises bare når booking er aktivert for produsenten) |

**Andre kandidater vi så, men ikke valgte** (ikke endret i denne skiven):

- Rett fra Bonden: kontaktskjema på produsentsiden for profiler med «kun kontaktskjema»
  (`src/routes/seo.ts`, `POST /produsent/:slug/kontakt`), det generelle kontaktskjemaet
  (`src/routes/seo.ts`, `/kontakt`), og meldingsskjemaet på kjøperens ordreside
  (`src/routes/buyer-order-card.ts`, `/ordre/:id`).
- Opplevagent: kontaktskjema på gårdssalg-profilen (`src/routes/experiences-seo.ts`,
  `POST /kategori/gardssalg/produsent/:providerSlug/kontakt`) og det generelle
  kontaktskjemaet (`/kontakt`).

## Funn: Rett fra Bonden, `/handleliste`

Skjemaet er i fire steg, og bare ett steg vises om gangen. Knappene er `type="button"` og
sendes med JavaScript som JSON. Derfor har feltene ingen `name`, og serveren leser
ikke skjemafeltene direkte. Skjemaet har `autocomplete="off"` på `<form>`; et
eksplisitt token på et felt overstyrer dette.

| Felt | Etikett (synlig) | Kobling | `type` | `autocomplete` før → etter | Annet lagt til | `required` | Vurdering |
|---|---|---|---|---|---|---|---|
| Vare (rad, bygges i skriptet) | «Vare» | Omsluttende `<label>` (+ `aria-label`) | text | (arvet `off`) → `off` | – | Nei (skriptet krever minst én vare) | OK |
| Antall (rad, bygges i skriptet) | «Antall» | Omsluttende `<label>` (+ `aria-label`) | number | (arvet `off`) → `off` | `inputmode="numeric"` | Nei (standard 1) | OK |
| `#hl-place` | «Sted» | Omsluttende `<label>` | text | (arvet `off`) → `address-level2` | – | Nei (skriptet krever sted når posisjon mangler) | Rettet |
| `#hl-name` | «Navn» | Omsluttende `<label>` | text | `name` → `name` | – | Nei (valgfritt) | OK |
| `#hl-email` | «E-post» | Omsluttende `<label>` | email | `email` → `email` | `inputmode="email"` | Nei (e-post **eller** telefon kreves ved bestilling) | OK |
| `#hl-phone` | «Telefon» | Omsluttende `<label>` | tel | `tel` → `tel` | `inputmode="tel"` | Nei (se over) | OK |
| `#hl-note` | «Leveringsønske (valgfritt)» | Omsluttende `<label>` | textarea | (arvet `off`) → `off` | – | Nei | OK |
| `#hl-consent` | Samtykketeksten | Omsluttende `<label>` | checkbox | – | – | Nei (kreves bare når noe bestilles) | OK |
| `#hl-website` (honningkrukke) | «Website» | Omsluttende `<label>`, beholder skjult utenfor skjermen med `aria-hidden` | text | `off` → `off` | – | Nei | Se forslag 3 |
| Send-knapp `#hl-submit` | «Send handlelisten» | – | button | – | `aria-describedby="hl-terms"` (peker på kjøpsvilkår-linjen) | – | Se forslag 1 |

## Funn: Opplevagent, `/kategori/gardssalg/book/:slug`

Skjemaet har `method="POST"` og sendes med JavaScript som JSON til
`/api/opplevelser/book`. Feltene har `name` som tilsvarer det serveren leser.

| Felt | Etikett (synlig) | Kobling | `type` | `autocomplete` før → etter | Annet lagt til | `required` (server krever?) | Vurdering |
|---|---|---|---|---|---|---|---|
| `provider_id` | – | – | hidden | – | – | (ja) | OK |
| `#slot_at` | «Dato og tid (norsk tid)» | `label for` | datetime-local | ingen → `off` | – | Ja (ja) | Rettet |
| `#party_size` | «Antall personer» | `label for` | number (1–50) | ingen → `off` | `inputmode="numeric"` | Ja (ja) | Rettet |
| `#guest_name` | «Navn» | `label for` | text | `name` → `name` | – | Ja (ja) | OK |
| `#guest_email` | «E-post» | `label for` | email | `email` → `email` | `inputmode="email"` | Ja (ja) | OK |
| `#guest_phone` | «Telefon (valgfritt)» | `label for` | tel | `tel` → `tel` | `inputmode="tel"` | Nei (nei) | OK |
| `#notes` | «Kommentar til produsenten (valgfritt)» | `label for` | textarea | ingen → `off` | – | Nei (nei) | Rettet |
| Send-knapp | «Reserver besøk» | – | submit | – | `aria-describedby="book-form-status"` (statuslinjen som sier om forespørselen ble sendt) | – | OK, tydelig |

Alle felt i begge skjema hadde allerede nøyaktig én etikett før endringen.
Testen sjekker at det fortsatt er slik.

## Forslag (ikke gjort; endrer synlig tekst, oppsett eller oppførsel)

1. **Knappetekst på Rett fra Bonden.** «Send handlelisten» sier ikke tydelig at det
   sendes en bestilling til produsenten. Forslag: «Send bestilling» (EN: «Send order»).
   Dette endrer synlig tekst og må avgjøres separat.
2. **«E-post eller telefon» på Rett fra Bonden.** Serveren krever samtykke og minst én av
   e-post eller telefon for å sende en bestilling. Dette står bare i feilmeldingen som
   vises etter et mislykket forsøk. En agent kan ikke se kravet på forhånd, og det kan
   ikke uttrykkes med `required`. Forslag: en kort synlig hjelpetekst under
   kontaktfeltene, koblet til feltene med `aria-describedby`.
3. **Honningkrukka «Website».** Feltet er skjult utenfor skjermen og har `aria-hidden`.
   En agent som leser hele DOM-en kan likevel fylle det ut, og da avviser API-et
   bestillingen. Forslag: vurder om feltet skal få et navn som tydelig sier «ikke fyll ut»,
   eller om honningkrukka skal erstattes med en annen spamsperre. Dette endrer oppsett
   og spamvern og hører ikke hjemme i en ren attributtskive.
4. **`name` på feltene i handlelisten.** Feltene har bare `id`. Noen agenter ser etter
   `name`. Feltene sendes som JSON, så navn påvirker ikke serveren. Det var likevel
   ikke på listen over tillatte endringer i denne skiven. Forslag: legg til
   `name` med samme verdi som API-feltene (`buyer_name`, `buyer_email`, `buyer_phone`,
   `delivery_note`) i en egen skive.
5. **`autocomplete="off"` på hele handleliste-skjemaet.** Felt uten eget token arver
   `off`. Alle felt med persondata har nå eget token, så dette er ufarlig i dag. Nye felt
   må likevel få eget token.
6. **`maxlength` på e-post i Opplevagent.** `#guest_email` har ingen `maxlength`, og
   skjemaet på serveren har ingen øvre grense for e-post. Forslag: 254 på både skjema og
   server, i en egen skive, siden dette endrer validering.
7. **Steg som skjules (Rett fra Bonden).** Steg 2–4 har `hidden` til skriptet viser dem.
   En agent må klikke «Finn produsenter» og «Videre til oppsummering» før kontaktfeltene
   finnes. Dette er greit, men MCP-verktøyene (`lokal_cart_*`) er fortsatt den sikreste
   veien for agenter.

## Tester og kontroll

- `src/routes/forms-browser-agent-g1-3.test.ts` (lagt inn i `tests/test.ts`):
  - AK1: begge sidene svarer 200, og hvert felt som ikke er `hidden`/`submit` har
    nøyaktig én etikett (`label[for]` eller omsluttende `<label>`).
  - AK2: den synlige teksten i hvert skjema er lik øyeblikksbildet fra `origin/main`.
  - AK3: de nye `autocomplete`/`inputmode`/`aria-describedby`-attributtene finnes, og
    feltnavnene serveren leser er uendret.
- `npx tsc --noEmit`: ingen feil.
- `npm test`: 77 783 bestått, 0 feilet (44 av dem i den nye testfila).

## FUNN TIL OPPFØLGING

- [FUNN] Forslag 1–4 og 6 over er anbefalinger uten saksnummer. De endrer synlig tekst,
  spamvern eller validering og bør vurderes som egne skiver.
