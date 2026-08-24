# Finn tannlege — Claude connectors directory: portal answer sheet

Every step of `claude.ai/admin-settings/directory/submissions/new`, answered.
Copy the fenced blocks verbatim. **Verified live 2026-08-24.**

> **Blocker:** step 7 needs a terms-of-service URL and `https://finn-tannlege.com/vilkar`
> is 404 today. Publish that page before starting the form. Everything else below is ready.

---

## 1. Connection

| Field | Answer |
|---|---|
| Server type | Remote MCP server |
| Transport | Streamable HTTP |
| Server URL | `https://finn-tannlege.com/mcp` |
| Protocol versions supported | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` |

The server is handshake-era: an `initialize` request must precede `tools/list`. A client
that sends `tools/list` first receives `Bad Request: Server not initialized`. Standard MCP
behaviour, not a fault.

## 2. Authentication

| Field | Answer |
|---|---|
| Authentication | **No authentication** |

Rationale to paste if the portal asks for one:

```
The server is a public, entirely read-only directory of Norwegian dental clinics. There
are no user accounts and no write operations, so there is nothing to authenticate against.
```

## 3. Tools

**5 tools. All read-only, none destructive.** Every one carries `title`, `readOnlyHint`
and `destructiveHint` (read live from the endpoint 2026-08-24).

> **Two title fields, and they disagree.** Each tool carries a top-level `title` *and* an
> `annotations.title`. For 2 of the 5 dental tools the two strings differ. Both are
> reproduced below verbatim, because which one a client displays depends on the client.
> Logged as a finding on the dev-request.

| Tool | `title` | `annotations.title` | What it does |
|---|---|---|---|
| `tannlege_search` | Search Norwegian dental clinics | *(same)* | Free-text search plus filters: county (fylke), specialty, Helfo direct-billing agreement, emergency duty (akuttvakt). |
| `tannlege_info` | Get full details for a dental clinic | **Get dental clinic details** | Full record for one clinic. |
| `tannlege_stats` | Norwegian dental market statistics | *(same)* | Totals, county breakdown, Helfo / akuttvakt / specialist counts. |
| `tannlege_akutt` | Find emergency-duty dental clinics in Norway | **Find emergency-duty dental clinics** | Clinics offering akuttvakt. |
| `tannlege_kjeder` | List Norwegian dental chains | *(same)* | Chain listing. **Returns nothing today** — live `tannlege_stats` reports `chain_count: 0`; no clinic is currently tagged to a chain. |

The connector performs **no writes of any kind**. There is no cart, no booking, no form
submission, nothing that creates or modifies a record.

## 4. Use cases

```
finn-tannlege.com is an independent search service for Norwegian dental clinics. The
connector lets Claude search roughly 6,961 clinics by county, specialty, whether the
clinic has a Helfo direct-billing agreement, and whether it offers emergency duty
(akuttvakt), and to read the full record for any one clinic.

It is read-only. No tool writes, books, submits or modifies anything, and the connector
handles no personal data about the user — a query is a place name and a filter.
```

Concrete use cases to list:

- Finding a dentist in a specific county or town.
- Finding emergency dental care (akuttvakt) outside normal hours.
- Filtering for clinics with a Helfo direct-billing agreement, which changes what the
  patient pays up front.
- Finding a clinic with a specific specialty (orthodontics, oral surgery, and so on).
- Comparing clinic coverage across counties.

## 5. Listing

See `listing.md` in this directory — name, tagline, description, categories, all with
character counts against the portal limits.

**Slug: `finn-tannlege`.** The listing slug is **PERMANENT after publication** — it cannot
be changed later. Type it deliberately.

## 6. Company

| Field | Answer |
|---|---|
| Company / developer name | Finn-tannlege |
| Website | `https://finn-tannlege.com` |
| Support contact | `da.fredriksen@gmail.com` |
| Country | Norway |

## 7. Data handling

```
The connector transmits only the search terms and filters the user's question implies — a
county name, a specialty, an emergency-duty flag. There are no user accounts, no login
credentials, no session tokens, no payment data and no health data: the user never sends a
medical question or a patient record through the connector, only a search for a clinic.

Clinic data served back is public business-directory information (clinic name, address,
contact details, specialties, Helfo agreement status, emergency-duty availability),
sourced from Brønnøysundregistrene, the Norwegian health-personnel register (HPR) and the
clinics' own websites.

Privacy policy: https://finn-tannlege.com/personvern
Terms of service: https://finn-tannlege.com/vilkar   <-- 404 TODAY. Must be published
                                                          before submitting.
```

## 8. Compliance

Financial-transaction question:

```
No. The connector processes no payments, holds no funds and touches no card or bank
details. Helfo agreement status is reported as a factual attribute of a clinic — it tells
the user whether the state's direct-billing arrangement applies there — and nothing more.
```

Regulated-content question — answer carefully, this one is real for a dental directory:

```
The connector returns business-directory information about dental clinics. It gives no
medical or dental advice, makes no diagnosis, recommends no treatment, and returns no
patient data. Specialty labels and Helfo agreement status are administrative facts about a
clinic, taken from public registries, not clinical guidance. Users are directed to contact
a clinic; the connector never stands between a patient and a clinician.
```

## 9. Test & launch

The server is **open — the reviewer needs no account, no key and no setup**. Full
instructions and prompts in `test-instructions.md` in this directory.

| Field | Answer |
|---|---|
| Test account needed | No — public server, no authentication |
| Icon | **Not available yet** — only an SVG favicon exists; a square PNG must be produced first |
| Documentation URL | `https://finn-tannlege.com/llms.txt` |
| Screenshots | Not applicable — tools-only server, no UI cards |

---

## Known gaps to state honestly if asked

- **Terms of service page missing** (`/vilkar` 404) — blocks step 7.
- **No square PNG icon** for this vertical; only `favicon.svg` (200). Related dev-request:
  `2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering`.
- **`tannlege_kjeder` has no data today** (`chain_count: 0`). The tool is real and
  correctly annotated, but must not be sold as a headline feature in the listing copy.
- **Search does not case-fold `Ø` (live defect, confirmed 2026-08-24).** `tannlege_search`
  with `query: "Tromsø"` returns **0** results while `"TROMSØ"` returns **79**. The same
  split shows on `Bodø` (1 vs 58) and `Førde` (1 vs 31). ASCII folds correctly
  (`bergen`/`BERGEN`/`Bergen` all 273) and so does `Å` (`Ålesund`/`ÅLESUND` both 82) — the
  bug is specific to `Ø`. This silently breaks the most natural way a Norwegian user types
  a place name. Keep `Ø` place names out of the reviewer prompts until it is fixed, and do
  not let listing copy promise a `Ø`-city example. Routed to the dev-request queue as its
  own item — it is a server defect, not a documentation problem.
