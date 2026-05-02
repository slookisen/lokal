# Enrichment Report — 2026-05-02

**Agent:** lokal-agent-enrichment  
**Run time:** ~30 min  
**Total agents:** 1,396 (1,392 → +4 new)

---

## Phase 1: Discovery — 4 new producers registered

All four new producers are from the Nordland/Salten region, sourced from REKO-ring Bodø members and Hanen.no listings. This strengthens coverage in North Norway.

| # | Producer | City | Category | Source |
|---|----------|------|----------|--------|
| 1 | Nordnes Kro og Camping | Røkland, Saltdal | bakery, meat | Hanen.no, nordnescamp.no |
| 2 | Solvold Gård | Mevika, Gildeskål | meat | gildeskal.com, REKO Bodø |
| 3 | Stokland Gård | Fauske | vegetables | REKO Bodø, Coop Nordland, nord24.no |
| 4 | Bakeverkstedet Salten | Misvær/Kvikstad | bakery | REKO Bodø, kulturveien.no |

**Regions searched:** Trøndelag, Nordland, Troms/Finnmark, Agder, Vestland, Møre og Romsdal, Innlandet, Rogaland, Vestfold/Telemark. Registry coverage is very high — nearly all Hanen.no and Lokalmat.no listed producers are already registered.

---

## Phase 2: Deep Content Enrichment — 8 agents enriched

### Successfully enriched (deep-crawled + knowledge updated):

**1. Fjordfolk Mikrobryggeri — Sandefjord** (ef67d512)
- Pages crawled: / (homepage had all content)
- About: "Håndverksbryggeri i Sandefjord som brenner for mangfoldet i øl..." (261 chars, NEW)
- Contact added: email (henriette@fjordfolkbrygg.no), phone (+47 98411260), address (Hågasletta 10, 3236)
- Specialties: Håndverksøl, Mikrobryggeri, Kontraktsbrygging

**2. Bofisk — Bodø** (42ff69eb)
- Pages crawled: /, /om-bofisk/
- About: "Fiskebutikk i Bodø med sesongbaserte leveranser fra lokale fiskebåter i Salten siden 2001..." (302 chars, UPDATED)
- Products: 9 products added (torsk, sei, hyse, fiskekaker, fiskepudding, fiskeboller, bacalao, fiskegrateng, sjømat)
- Opening hours: Mon-Fri 10-17, Sat 10-15
- Phone: +47 47907577 (daglig leder Harald Lorentzen)

**3. Butterfly Bakeri og Konditori — Sarpsborg** (8ab60f00)
- Pages crawled: / (homepage)
- About: "Bakeri og konditori med hovedbase på Grålum i Sarpsborg. 25 årsverk..." (285 chars, NEW)
- Products: 12 products added (steinovnsbakt brød, baguetter, kremkaker, spesialkaker, bryllupskaker, etc.)
- Contact: email (firmapost@butterfly-bakeri.no), phone (+47 69142280), address (Gaupefaret 2, 1712)
- Note: 6 butikker (Christianslund, Grålum, Kråkerøy, Lande, Skjeberg, Tistasenter)

**4. Den Sorte Havre — Tveter Gård, Våler** (da6bf1cf)
- Pages crawled: /, /om-oss/, /kontakt/
- About: "På Tveter Gård i Våler i Østfold har familien Anstensrud tatt frem igjen svarthavren..." (387 chars, NEW)
- Products: 5 products with prices (Steel Cut kr 44,90, Lettkokt kr 41,90, Müsli kr 59,90, etc.)
- Contact: email (post@densortehavre.no), phone (+47 90113875), address (Mørkveien 640, 1592)
- Certifications: Spesialitet (added)

**5-8. New registrations** (see Phase 1) — all four enriched immediately after registration with about-text, products, and contact info where available.

### Skipped / could not crawl:

| Agent | Reason |
|-------|--------|
| Sørli Gård (sorligard.no) | Website unreachable (HTTP 000) |
| Berles Gårdsbutikk (berles.no) | Cloudflare WAF blocked bot crawl |
| Huseby Gård (husebygaarden.no) | Website unreachable (HTTP 000) |

### Issues for Daniel:

- **Folvell Gård — Årnes** (f816f044): Website says "Vi produserer dessverre ikke jordbær på gården lenger." — business appears closed/inactive. Consider removing or flagging.
- **Oppsal Torg Frukt og Grønt** (f31a9792): Website (oppsalsenter.no) is a shopping mall (Oppsal Senter, OBOS). Not a food producer — likely misclassified. Review for removal or recategorization.

---

## Phase 3: Product Cleanup — 0 agents needed cleaning

Scanned 400 agents across two ranges (0-200, 800-1000). No emoji noise, section headers, out-of-stock entries, or wrong-category products found. Previous cleanup runs have been effective.

---

## Phase 4: Google Ratings — 17 new ratings added

Submitted batch of 28 agents missing ratings. 17/28 returned Google ratings. New ratings include:
- Nordneskroa: 4.3 (917 reviews!)
- Stokland Gård: rating added
- 15 other agents from the tail of the registry

---

## Phase 5: Verification

No duplicate detection run this session (rate limit budget was consumed by the initial enrichment candidate scan of 600+ agents). Verification deferred to next run.

---

## Coverage Stats (estimated)

| Metric | Count | % |
|--------|-------|---|
| Total agents | ~1,396 | 100% |
| With website | ~900 | ~64% |
| With email | ~850 | ~61% |
| With Google rating | ~1,050 | ~75% |
| With rich about (>150 chars) | ~1,100 | ~79% |
| With 3+ products | ~1,000 | ~72% |

---

## Enrichment Progress Tracker

Previous enrichment runs have brought about-text coverage to ~79%. Target is 100% of agents with websites by end of May. Today's run enriched 8 agents with rich about-text and products, and added 4 new agents to the registry.

---

## Issues for Daniel

1. **Folvell Gård** — appears closed (no longer producing). Remove?
2. **Oppsal Torg Frukt og Grønt** — is actually a shopping mall, not a food producer. Remove or recategorize.
3. **Rate limit note:** Scanning 600 agents for enrichment candidates consumed the entire 300 req / 15 min budget. Future runs should scan in smaller batches with delays.
4. **Sørli Gård, Huseby Gård** — websites unreachable. May be temporarily down or permanently gone. Re-check next run.
