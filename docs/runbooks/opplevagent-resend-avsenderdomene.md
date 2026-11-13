# Runbook: opplevagent.no som avsenderdomene i Resend

Dev-request `2026-11-06-opplevagent-avsenderdomene-og-minimum-for-pilot`, slice O4-1.

**Mål:** Opplevagent-e-post (bookingvarsler, gårdssalg-lenker, utsending, CS-svar på
Opplevagent-tråder) sendes FRA `kontakt@opplevagent.no` i stedet for den delte
`kontakt@rettfrabonden.com`. Koden er klar bak flagget
`OPPLEVAGENT_SENDER_DOMAIN_ENABLED` (av som standard). Rett fra Bonden og dental
påvirkes ikke, uansett flagg.

**Rekkefølgen er viktig:** domenet må være verifisert i Resend FØR flagget slås på.
Slås flagget på først, avviser Resend alle Opplevagent-utsendinger.

## 1. Legg til opplevagent.no som avsenderdomene i Resend

1. Logg inn på Resend → **Domains** → **Add Domain** → `opplevagent.no`.
2. Velg samme region som `rettfrabonden.com` bruker.
3. Resend viser nå en liste med DNS-poster (typisk DKIM-TXT under
   `resend._domainkey`, samt MX og SPF-TXT på et send-subdomene, f.eks. `send`).
   La siden stå åpen — verdiene skal kopieres nøyaktig derfra.

> Merk: Resends gratisplan verifiserer bare ett domene. Sjekk at planen tillater et
> ekstra domene før du går videre.

## 2. Legg inn postene i Namecheap

Namecheap → **Domain List** → `opplevagent.no` → **Advanced DNS**.

- Kopier **hver** post Resend viser — type, host/navn og verdi — **nøyaktig** slik
  Resend viser dem. Ikke skriv verdier for hånd og ikke gjett; bruk kopier-knappen i
  Resend.
- Namecheap legger til domenet selv: der Resend viser `resend._domainkey.opplevagent.no`,
  skriver du bare `resend._domainkey` i Host-feltet (tilsvarende for `send`).
- MX-posten Resend ber om gjelder **send-subdomenet** (f.eks. `send`), ikke roten.

### ADVARSEL: ikke rør MX for rotdomenet

Siden 2026-11-11 peker MX for `opplevagent.no` (host `@`) på **Resend inbound**. Svar
til `kontakt@opplevagent.no` kommer inn via inbound-webhooken og arkiveres på
`experiences` i CRM. Endrer eller sletter du rot-MX, slutter svarene å komme fram.

- Ikke slett eller endre eksisterende MX på `@`.
- Ikke legg til nye MX-poster på `@`.
- Ikke slå på Namecheaps «Email Forwarding» / mail-innstillinger som overskriver MX.

## 3. DMARC

Sjekk om `_dmarc.opplevagent.no` allerede har en TXT-post.

- Finnes den ikke: legg til TXT, host `_dmarc`, og start med overvåkning:
  `v=DMARC1; p=none;` (legg gjerne til `rua=mailto:<adresse du leser>` for rapporter).
- Finnes den: behold den, men sørg for at den ikke er strengere enn `p=none` i
  startfasen. Skjerp til `quarantine`/`reject` først når rapportene viser at alt
  passerer.

## 4. Verifiser i Resend

1. Vent på DNS-propagering (ofte minutter, kan ta noen timer).
2. Trykk **Verify** på domenet i Resend. Alle poster skal bli grønne / «Verified».
3. Kontroller med `dig` (valgfritt):
   ```bash
   dig +short TXT resend._domainkey.opplevagent.no
   dig +short MX opplevagent.no          # skal fortsatt vise Resend inbound
   dig +short TXT _dmarc.opplevagent.no
   ```

## 5. Testutsending

Før flagget slås på i produksjon: send en testmail fra `kontakt@opplevagent.no` til
din egen Gmail (f.eks. via Resend-dashboardets testfunksjon eller API).

I Gmail: **Vis original** («Show original») og sjekk at
- `SPF: PASS`
- `DKIM: PASS` (med `d=opplevagent.no`)
- `DMARC: PASS`

Svar også på testmailen og sjekk at svaret havner i CRM på `experiences` — det
bekrefter at rot-MX fortsatt er urørt.

## 6. Slå på flagget i Fly

Først når punkt 4 og 5 er grønne:

```bash
fly secrets set OPPLEVAGENT_SENDER_DOMAIN_ENABLED=true
```

(Gyldige «på»-verdier: `true` eller `1`, uavhengig av store/små bokstaver. Alt annet,
også tom/ikke satt, betyr av.) Flagget leses ved hvert kall, men `fly secrets set`
restarter appen uansett.

Etterpå: utløs én Opplevagent-e-post (f.eks. en gårdssalg-innloggingslenke til deg
selv) og sjekk at `From:` er `"Opplevagent" <kontakt@opplevagent.no>` og at
SPF/DKIM/DMARC passerer.

## Tilbakerulling

```bash
fly secrets unset OPPLEVAGENT_SENDER_DOMAIN_ENABLED
```

(eller sett den til `false`). All Opplevagent-post går da igjen fra
`kontakt@rettfrabonden.com`, byte-identisk med før. DNS-postene og domenet i Resend
kan bli stående — de skader ikke.
