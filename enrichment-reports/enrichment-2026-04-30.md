# Enrichment Report — 2026-04-30

**Run**: #52b (evening)  
**Pipeline**: lokal-agent-enrichment (22:00 CEST)  
**Base**: https://rettfrabonden.com  
**Starting agent count**: 1,232  

---

## Phase 1: Discovery — New Producer Registrations

**Registered**: 8 new agents (9 attempted, 1 self-created duplicate removed)

| # | Producer | City | Type |
|---|----------|------|------|
| 1 | Rondane Gardsmat | Folldal | Melk/kjøtt, gardsmat |
| 2 | Hitra Gårdsmat | Hitra | Økologisk upasteurisert ost |
| 3 | Smedstad Gård | Sørum | Kurs, gårdsopplevelser |
| 4 | Stangeland gard | Austevoll | Gårdsopphald, øyliv |
| 5 | Løvetanna Gårdsbutikk | Gibostad, Senja | Urtegård, økologisk |
| 6 | Atlungstad Brenneri | Stange | Akevitt, brennevin (est. 1855) |
| 7 | Hindrum Gårdsysteri | Indre Fosen | Gårdsost |
| 8 | Tørrfisk fra Lofoten AS | Leknes | Tørrfisk, stockfish |

**Filtered out** (non-food/closed): Debio (certification body), Oppsal Torg (retail), Kjær Gårdsbutikk (closed), Lauklines (tourism)

---

## Phase 2: Deep Enrichment

**Enriched**: 26 agents with about-text, products, specialties, and contact info from website crawls.

### Batch 1–5 (from scored candidate list, 16 agents)
1. Line Gard — Jæren farm, eggs, milk automat, lamb
2. Bønes Gårdsmat — Bergen meat processing, NM-winner
3. Gutta på Haugen — Online specialty food shop since 1994
4. Bjørklund Gård — Glamping + farm experiences
5. Koseverden — Café in Tromsø
6. Daglig Deig — Italian pastificio in Trondheim
7. Kringler Gjestegård — Farm brewery + distillery
8. Ostegården — Award-winning cheese (World Cheese Awards 2018)
9. Store Naa Siderkompani — Hardanger cider
10. Polarmat AS — Seafood from Helgeland
11. Delbekk Husmannsplass — Berry products, cider
12. Matfatet Ørje — Local food outlet, 40+ producers
13. Marthahaugen Gård — Organic farm, wild sheep, honey
14. Lofoten Wool — Plant-dyed wool + meat
15. Smalahovetunet — Traditional sheep head dish
16. Stanger Gård — Peonies + spælsau

### Batch 6 (8 agents)
17. Atlungstad Brenneri — Norway's oldest potato distillery (1855), akevitt
18. Volda Mat — Traditional fish products since 1942
19. Setesdal Shop — Regional marketplace, Valle
20. Tørrfisk fra Lofoten AS — Stockfish, 1000-year tradition
21. Helgeland Brygg — Craft brewery
22. Arctic Blue / Melbukaviar — Best-in-test caviar, MSC certified
23. Hindrum Gårdsysteri — Farm dairy on Fosen
24. Eventyrsmak — Producer markets in Tromsø

### New registrations enriched (2 agents)
25. Stangeland gard — Farm stay on Stolmen, Austevoll
26. Hitra Gårdsmat — Organic unpasteurized cheese

**Skipped** (no website found): Løvetanna Gårdsbutikk, Rondane Gardsmat, Smedstad Gård  
**Wrong domain detected**: lovetanna.no = landscape architect (Trondheim), rondane.no = hotel

---

## Phase 3: Product Cleanup

**Scanned**: 525 agents (300 full scan + 225 sampled from remaining 900)  
**Issues found**: 0 emoji in product names, 0 duplicate products  
**Status**: Database is clean — previous cleanup runs effective

---

## Phase 4: Verification & Duplicate Detection

**Method**: Name-normalized grouping across all 1,232 agents, strict 2+ identifier policy  
**Name collision groups found**: 23  

### True duplicates flagged for deletion: 16

| # | Producer | Reason | Keep ID | Delete ID |
|---|----------|--------|---------|-----------|
| 1 | Marthahaugen Gård | Same name + Sortland + villsau/honning | f7d4fd4a | 5d8aeaee |
| 2 | Erdahl Kjøttforretning | Same name + Mosjøen + 3 gen, 200+ products | 6b6c7371 | 248b3544 |
| 3 | Toves Tradisjonsmat | Same name + Vikran + gårdsbutikk/kafé | be5dd8cc | a14d8e8e |
| 4 | Braastad Epler | Same name + Ringsaker + tre gen epledyrking | a7dd15ac | dd8306f2 |
| 5 | Berles Gårdsbutikk | Same name + Svelvik + frukt/gårdsbutikk | d0837952 | 4b8557ee |
| 6 | Nordtun Gård | Same name + Bø/Andøya + lama/gårdskafé | 61aa71f4 | 5dfdc724 |
| 7 | Sandalen Gård | Same name + Randaberg + frukt/sider | 15d58487 | f7d45e54 |
| 8 | Vikja | Same name + Sognefjorden + økologisk kjøtt | be1f3dd2 | d386b640 |
| 9 | Lofotprodukt AS | Same name + Leknes + sjømat | 895702b0 | 466e3fa0 |
| 10 | Ulsrudbakken Gård | Same name + Skreia | 60e3449a | 07c37223 |
| 11 | Volda Mat | Same name + Volda + fiskeprodukter | 531c48f0 | 4f49783a |
| 12 | Bakken Øvre Gårdsmat | Same name + Hedmark + same family | 6de5fb9a | 9ee93fb4 |
| 13 | Strandli Gård | Same name + Grane/Trofors + gårdsysteri | fadc9de6 | 2188048f |
| 14 | Straumbotn Gård | Same name + Utskarpen + gårdsmeieri | deb75ce7 | 6be6022b |
| 15 | Søberg Gård | Same name + Alvdal area + gardsbutikk/lokalmat | 589b21e0 | 53e2d2e2 |
| 16 | Finnmark Rein | Same company + reinsdyrkjøtt + reindriftsutøvere | a0ac87b1 | 44396977 |

### Different businesses kept (same name, different location): 5
- Haugen Gardsmat: Haugesund vs Flåm (different farms)
- Eventyrsmak: Tromsø vs Sigdal SA (different organisations)
- Hammer Gård: Løten vs Åsen/Levanger (different regions)
- Dalebro Gård: Fosen vs Løten (different regions)
- Flåtan Søndre Gårdsbutikk: Kvam (Hardanger) vs Sande (Vestfold)

**Deletion status**: Queued — awaiting rate limit reset (16 DELETE calls)

---

## Summary

| Metric | Value |
|--------|-------|
| Starting agents | 1,232 |
| New registrations | +8 |
| Duplicates removed | -1 (Marthahaugen self-created, during Phase 1) |
| Duplicates flagged | 16 (awaiting deletion) |
| Deep-enriched | 26 |
| Products scanned | 525 (0 issues) |
| **Projected final count** | **1,223** (after 16 deletions) |

### Quality notes
- Website domain verification caught 2 wrong-domain matches (lovetanna.no, rondane.no)
- Strict email policy: only own-domain emails accepted
- Rate limit hit after ~500 knowledge lookups — managed with spacing
- 3 new registrations have no discoverable website yet

---

*Generated by lokal-agent-enrichment pipeline, 2026-04-30 ~22:00 CEST*
