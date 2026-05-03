# Enrichment Report — 2026-05-03

## Summary
- **Total agents**: 1,396 → 1,401 (+5 registered)
- **Run time**: ~40 min (rate-limited mid-run)
- **Focus**: Discovery (5 new) + Deep enrichment (2 agents) + Product cleanup (2 agents) + Google ratings (4 new ratings)

---

## Phase 1: Discovery (5 new producers registered)

| # | Name | City | Region | Source | Categories |
|---|------|------|--------|--------|------------|
| 1 | Billingen Seterpensjonat — Skjåk | Skjåk | Innlandet | HANEN, Matrute Gudbrandsdalen | meat, bakery |
| 2 | Mylnå — Volda Elektriske Mylne | Volda | Møre og Romsdal | Proff.no, BazPoint concept | bakery, vegetables |
| 3 | Lundemannsverk — Stord | Stord | Vestland | NRK TV series, Facebook, own website | vegetables, fruit, eggs |
| 4 | Haugslia Gårdsbutikk — Verdal | Verdal | Trøndelag | Opplev Verdal, Facebook | meat, vegetables |
| 5 | Stana Lokalmat — Ullensvang | Ullensvang | Vestland | Own website + nettbutikk | meat, vegetables |

All were immediately deep-enriched with about text, products, contact info and specialties.

**Blocked**: Holte Gårdsmat (Drangedal) — on agent blocklist (likely GDPR opt-out).

**Regions targeted**: Verdal (was <3 agents), Stord, Ullensvang, Volda (was <3 agents), Skjåk — all under-represented.

---

## Phase 2: Deep Enrichment (2 agents updated)

### Voll Gård — Hele Byens Bondegård (Trondheim)
- **Pages crawled**: / (homepage, 3034 chars extracted)
- **Before**: about 227ch, 2 generic products
- **After**: about 337ch (added Moholt location, urban dyrking, ridning/stall, 4H), 6 specific products
- **Specialties**: Added "Urban dyrking", "Ridning og stall"

### Lille Tøyen Kolonial (Oslo) — DEFERRED
- Website unreachable (DNS timeout). Enrichment data prepared from web search (DN.no, Anders Husa review, Mer av Oslo).
- Data: about 260ch, phone, address, 5 products, opening hours, specialties.
- **Status**: PUT request rate-limited. Will retry next run.

---

## Phase 3: Product Cleanup (2 agents fixed)

| Agent | Issue | Fix |
|-------|-------|-----|
| Kinsarvik Naturkost — Bergen | 3 products incorrectly categorized as "other" | Helsekost→herbs, Kosttilskudd→herbs, Glutenfrie→bakery |
| Matboden Rogaland — Stavanger | "Påsmurt og smørbrød" as "other" | Reassigned to bakery; Tapas/Koldtbord→meat |

**RYGR Brygghús** — flagged for ALL CAPS product name "RYGR IPA" but determined this is brand name, not noise. No change needed.

---

## Phase 2F: Google Ratings

- Submitted 14 agents (from initial scan) → 1 enriched
- Submitted 5 new registrations → 3 enriched (Billingen 4.8★/511 reviews, Mylnå + 1 other)
- Broader scan (80-200): 0 agents missing ratings — excellent coverage!

**Total new ratings this run**: 4

---

## Phase 4: Verification

No duplicates found in this run. The registry is well-maintained — broad scans across 600+ agents found minimal issues.

**Observations**:
- berles.no redirects to retailhub.no (Cloudflare-blocked) — may not be a farm shop anymore. Flag for Daniel.
- lilletoyenkolonial.no returning DNS timeout — business may have changed web hosting.
- Several candidate websites (raaensider.com, mfrp.no, husebygaarden.no) completely unreachable — JS-only or down.

---

## Coverage Stats

| Metric | Value | Notes |
|--------|-------|-------|
| Total agents | 1,401 | +5 from discovery |
| Google rating % | ~99% | Near-complete coverage |
| Rich about (>150 ch) | ~95% | Estimated from sampling |
| Product count ≥3 | ~96% | Very few with <3 products |
| Email % | ~70% | Many small farms have no public email |

---

## Enrichment Progress Tracker

The database is in excellent shape. From sampling 580+ agents across all ranges:
- 0 agents found without website that needed enrichment (idx 400-1250)
- Only 11 candidates with any enrichment need (idx 200-400)
- Most enrichment needs are minor (2 products instead of 3, etc.)

**Target**: All agents with websites should have rich about-text (>150 chars) → ~95% achieved.

---

## Issues for Daniel

1. **Rate limiting**: Hit 300 req/15min limit mid-run, preventing Lille Tøyen Kolonial update. Consider raising limit for admin-key requests.
2. **berles.no → retailhub.no**: Berles Gårdsbutikk's website now redirects to a retail platform behind Cloudflare. Verify if still active farm shop.
3. **Holte Gårdsmat on blocklist**: New high-tech 24/7 farm shop in Drangedal (opened March 2026, Liberty Now tech) — is this intentional? It's a legitimate farm shop.
4. **JS-rendered sites**: ~5 candidate websites are completely inaccessible to curl (JS-only rendering). May need browser-based crawl for: raaensider.com, mfrp.no, husebygaarden.no, lilletoyenkolonial.no.
