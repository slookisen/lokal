# Finn tannlege — reviewer test instructions

Paste this block into the portal's "how should we test your connector" field.

```
No account, key or setup is needed. The server is public, unauthenticated and entirely
read-only — add https://finn-tannlege.com/mcp and start asking. Answers come back in
Norwegian or English, whichever you ask in.

Try these four:

1. "Find a dentist in Bergen"
   -> tannlege_search. Returns clinics with address and contact details.

2. "Which dental clinics in Oslo have a Helfo agreement?"
   -> tannlege_search with the Helfo filter. Helfo is the Norwegian state direct-billing
      arrangement; it changes what the patient pays up front.

3. "I need emergency dental care in Rogaland tonight"
   -> tannlege_akutt. Returns clinics offering emergency duty (akuttvakt). This tool
      filters by county (fylke) only, so name a county rather than a town.

4. "How many dental clinics are there in Norway, by county?"
   -> tannlege_stats. Returns the totals and the per-county breakdown.

No tool in this connector writes anything, so there is nothing you can test that would
create, change or send a record. The connector returns directory information only and
gives no dental advice.
```

## Notes for us, not for the portal

- The four prompts exercise 3 of the 5 tools. `tannlege_info` is the natural follow-up to
  prompt 1 ("tell me more about that one") and needs no separate instruction.
- **`tannlege_kjeder` is deliberately absent from the prompts.** Live `tannlege_stats`
  reports `chain_count: 0`, so a reviewer asking "which dental chains are there?" would get
  an empty answer and read it as a broken tool. Do not add it to the review path until the
  chain data is actually populated.
- **Prompt 3 names a county, not a town, on purpose.** `tannlege_akutt`'s live
  `inputSchema` has exactly one property, `fylke` — no free-text query. Measured live:
  `{"fylke":"Rogaland"}` → **43** (Oslo 144, Vestland 76), but `{"fylke":"Stavanger"}` — a
  town, not a county — → **0**. Omitting `fylke` entirely, or passing an unrecognised
  property such as `{"query":"Stavanger"}`, returns the unfiltered national **732**. So the
  two ways to get this wrong fail in *opposite* directions: a town name silently yields
  nothing, while an ignored parameter silently yields every emergency clinic in Norway.
  Town-level emergency search goes through `tannlege_search` with `akutt: true` instead.
- The county breakdown in prompt 4 includes two housekeeping rows — `Ukjent` (27) and
  `TEST` (1). Harmless, but worth knowing before a reviewer asks what `TEST` is.
- **Prompt 1 deliberately uses an ASCII-only city.** The first draft said "Tromsø", which
  returns **0** results live: search does not case-fold `Ø` (`"Tromsø"` 0 vs `"TROMSØ"` 79;
  same on `Bodø` 1/58 and `Førde` 1/31, while `Å` and plain ASCII fold correctly). Handing
  a reviewer a prompt that returns nothing is the exact failure this file warns about for
  `tannlege_kjeder`. Restore a `Ø` city here only after the collation bug is fixed —
  it is routed to the dev-request queue as its own item.
