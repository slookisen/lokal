# Roadmap: Agent Card Improvements

> Last updated: 2026-04-19
> Based on: Gap analysis of 1409 agents + A2A protocol research

## Current Status

- 1409 agents total, 0 verified, 0 claimed
- Average trust score: 0.411
- Strong coverage: name (100%), about (92%), address (92%), specialties (100%)
- Weak coverage: phone (33%), email (39%), openingHours (50%), externalLinks (16%), googleRating (0%), externalReviews (0%)

---

## Tier 1: Enrichment Gaps — Lav innsats, høy effekt
**Status: 🟡 In Progress**
**Goal:** Fill the most visible and impactful data gaps via automated enrichment.

### 1.1 Google Ratings & Reviews
- **Gap:** 0% coverage — no agents have googleRating or externalReviews
- **Source:** Google Maps Places API / search scraping
- **Fields:** `googleRating` (float 1.0–5.0), `googleReviewCount` (int), `externalReviews` (array)
- **Impact:** Star ratings are the #1 trust signal for consumers. Immediately lifts perceived quality.

### 1.2 External Links (Facebook, Instagram, Google Maps)
- **Gap:** 16% coverage
- **Source:** Facebook search, Instagram search, Google Maps
- **Fields:** `externalLinks` array with `{label, url, type}` objects
- **Impact:** Gives users multiple paths to connect with the producer. Critical for producers without their own website.

### 1.3 Opening Hours
- **Gap:** ~50% coverage
- **Source:** Google Maps (best), producer website, Gulesider
- **Fields:** `openingHours` array with `{day, open, close}` objects
- **Impact:** Practical info that determines whether someone visits. Especially important for gårdsbutikker with limited hours.

### 1.4 Continue Phone & Email
- **Gap:** Phone 33%, Email 39%
- **Source:** 1881.no, Gulesider, proff.no, producer website, Facebook
- **Impact:** Core contact info — can't do business without it.

---

## Tier 2: Ny Funksjonalitet i Plattformen
**Status: ⬜ Not Started**
**Goal:** Add new fields and features that differentiate us from a simple directory.

### 2.1 Bilder / Logo
- Add `imageUrl` and `iconUrl` to agent card schema
- Sources: Google Places photos, Facebook profile/cover photos, producer website
- Visual impact on marketplace listing is huge — text-only cards feel lifeless

### 2.2 Sesongkalender
- New field: `seasonality` — maps products to months
- Format: `{"jordbær": [6,7,8], "epler": [8,9,10,11], "honning": [7,8,9]}`
- Unique differentiator — no other A2A/food platform has this
- Enables "hva er i sesong nå?" queries via MCP

### 2.3 Leveringsradius & Minstebestilling
- New fields: `deliveryRadius` (km), `minOrderValue` (NOK)
- Makes agents useful for actual commerce decisions
- Source: producer website, Facebook page info

### 2.4 Språk
- New field: `languages` — array, e.g. `["no", "en"]`
- Relevant for tourist areas and international buyers

---

## Tier 3: A2A-Protokollforbedringer
**Status: ⬜ Not Started**
**Goal:** Align with A2A spec best practices and make agents more capable for AI-to-AI interaction.

### 3.1 Rikere Skills-modell
Replace the single "default" skill with specific, actionable skills:
- `browseCatalog` — list products with prices/availability
- `checkAvailability` — is a product in season now?
- `getDeliveryTerms` — delivery options, radius, minimum order
- `getCertifications` — certifications with verification status
Each skill declares `inputModes` and `outputModes` per A2A spec.

### 3.2 Schema.org JSON-LD
- Add `LocalBusiness` and `Product` structured data to SEO profile pages
- Can be auto-generated from existing knowledge data
- Improves Google search visibility dramatically

### 3.3 Authenticated Extended Cards
- A2A spec supports auth-gated extended info
- B2B buyers (restaurants, butikker) get more details: direct phone, wholesale prices, volume discounts
- Requires seller claiming + verification first

### 3.4 schemaVersion & agentVersion
- Add A2A-spec compliant versioning to agent cards
- `schemaVersion`: "urn:a2a:1.0"
- `agentVersion`: increments when seller updates their info

### 3.5 Trust & Reputation Protocol
- A2A has no standard trust spec yet (emerging: A2Apex, HiveTrust, AgentStamp)
- Our trust score is custom — document it as a public signal
- Consider exposing trust methodology as a skill: `getTrustReport`

---

## Milestones

| Milestone | Target | Depends On |
|-----------|--------|------------|
| Tier 1 complete (ratings, links, hours) | Late April 2026 | Enrichment runs |
| Tier 2.1 Images MVP | May 2026 | Schema change + image source pipeline |
| Tier 2.2 Seasonality | May 2026 | New knowledge field + MCP query support |
| Tier 3.1 Rich skills | June 2026 | Backend skill routing |
| First seller claims agent | May 2026 | Claim flow UX |
| Schema.org live on profiles | May 2026 | SEO profile template update |
