# Finn tannlege — reviewer test instructions

Paste this block into the portal's "how should we test your connector" field.

```
No account, key or setup is needed. The server is public, unauthenticated and entirely
read-only — add https://finn-tannlege.com/mcp and start asking. Answers come back in
Norwegian or English, whichever you ask in.

Try these four:

1. "Find a dentist in Tromsø"
   -> tannlege_search. Returns clinics with address and contact details.

2. "Which dental clinics in Oslo have a Helfo agreement?"
   -> tannlege_search with the Helfo filter. Helfo is the Norwegian state direct-billing
      arrangement; it changes what the patient pays up front.

3. "I need emergency dental care in Bergen tonight"
   -> tannlege_akutt. Returns clinics offering emergency duty (akuttvakt).

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
- The county breakdown in prompt 4 includes two housekeeping rows — `Ukjent` (27) and
  `TEST` (1). Harmless, but worth knowing before a reviewer asks what `TEST` is.
