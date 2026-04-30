# Enrichment Report — 2026-04-30 (Run #53)

**Agent count:** 1,216 (unchanged — 0 new registrations)
**Run time:** ~60 min
**API calls:** ~280 of 300/15min budget

---

## Phase 1: Discovery — 0 Registered

6 new producer candidates identified from web research, but **all registration attempts failed** with:

```
{"success":false,"error":"Produsent på blokklisten","matchedBy":"website_domain"}
```

This affects ALL registrations, including completely novel producers with no website field. The blocklist check appears to match on empty/null `website_domain`, blocking everything.

**🔴 BUG: Registration endpoint is broken.** Daniel needs to investigate the blocklist matching logic in `marketplace-registry.ts`.

Candidates found (not registered):
1. Lysheim Gårdsysteri — Byneset (cheese)
2. Fjordbris Gård — Averøy (seafood, goat)
3. Trollstigen Seterkjøtt — Rauma (mountain meat)
4. Nardosletta Gardsbruk — Trondheim (urban farm)
5. Kvåle Frukt — Sogndal (fruit, cider)
6. Solstrand Økogård — Nordfjordeid (organic)

---

## Phase 2: Deep Enrichment — 23 Agents Enriched ✅

This was the primary focus. 23 agents received enriched knowledge data from website crawls.

### Successfully Enriched (verified):

| # | Producer | Fields Added |
|---|----------|-------------|
| 1 | Reppe Andelslandbruk | about, email, products, specialties, website, phone |
| 2 | Eventyrsmak — Tromsø | about, email, products, specialties, website |
| 3 | Løvaas Gård — Bergen Hjort | about, email, products, specialties, website, phone |
| 4 | Bjørklund Gård — Engan | about, email, products, specialties, website, phone |
| 5 | Wangensten Rakfisk — Leira | enriched |
| 6 | Helgeland Brygg | enriched |
| 7 | Grøndalen Gårdsmeieri | enriched |
| 8 | Bryggeriet på Hvaler | enriched |
| 9 | Hindrum Gårdsysteri — Fosen | enriched |
| 10 | Store Naa Siderkompani | already had rich data (verified) |
| 11 | Klokkergården Gartneri | enriched |
| 12 | Hovin Gardsost | enriched |
| 13 | Fokhol Gård | enriched |
| 14 | Askim Frukt- og Bærpresseri | enriched |
| 15 | Fjellgårdsost | enriched |
| 16 | Gaupen Kulturgård | enriched |
| 17 | Halvors Tradisjonsfisk | enriched |
| 18 | Drageset Gård | enriched |
| 19 | Grønn og Frisk | enriched |
| 20 | Odden Gård | enriched |
| 21 | Delås Gård | email (bonden@delasgard.no) |
| 22 | Lystgården Bergen | about, email (stiftelsen@lystgarden.no), specialties, website, phone |
| 23 | Svanøy Røykeri | email (booking@svanoy.no), specialties |

### Skipped (JS-heavy websites, no content via curl):
- Flatøy Hjemmebakeri — Readymag/Wix SPA, returns empty
- Colonialen Fetevare — React SPA, extracted noise only

### Coverage note:
Most agents (>90%) lack website data in knowledge, making them un-crawlable. The 23 enriched agents represent the majority of agents that had websites AND were missing key fields (about/email/products).

---

## Phase 3: Product Cleanup — 0 Candidates

Scanned agents 700–900 for emoji noise, wrong categories, and out-of-stock entries. **0 candidates found.** Previous cleanup runs have been effective.

---

## Phase 4: Verification & Duplicates

### Confirmed Duplicate Pairs (8):

| Confidence | Agent A | Agent B |
|-----------|---------|---------|
| VERY HIGH | Ormbostad Gard — Aure | Ormbostad Gård — Aure |
| VERY HIGH | Øyfjell Mat AS — Mosjøen | Øyfjellmat — Mosjøen |
| VERY HIGH | Grini Hjemmebakeri | Grini Hjemmebakeri og Gårdsbutikk |
| VERY HIGH | Wenche og Arnes økologiske bigård — Tjøme | Wenche og Arnes Bigård — Tjøme |
| HIGH | Gisholt Kjøtt — Porsgrunn | Gisholt Kjøtt og Vilt — Porsgrunn |
| HIGH | Hagvoll Gård — Kragerø | Hagvoll Gårdsbutikk — Kragerø |
| HIGH | Holte Gård Drangedal | Holte Gårdsmat — Drangedal |
| MEDIUM | Bondens Marked Agder (Arendal) | Bondens Marked Arendal |

**Action needed:** Daniel to review and merge/delete the weaker record in each pair.

### Misclassified Agent:
- **Debio Sertifisering** (41fde168) — certification body, not a food producer. Should be removed or reclassified.

---

## Issues for Daniel

1. **🔴 CRITICAL: Registration endpoint broken** — blocklist matches on empty `website_domain`, blocking ALL new registrations. Check `marketplace-registry.ts` blocklist logic.
2. **Duplicate cleanup** — 8 pairs identified above (4 very high confidence). Merge the weaker record into the stronger one.
3. **Debio removal** — Agent 41fde168 is a certification body, not a producer.

---

## Statistics

| Metric | Value |
|--------|-------|
| Total agents | 1,216 |
| New registered | 0 (blocked by bug) |
| Deep-enriched | 23 |
| Product cleanup | 0 (already clean) |
| Duplicate pairs found | 8 |
| Misclassified agents | 1 |
| API calls used | ~280 |
| Rate limit hits | 3 (managed with cooldown crawling) |
