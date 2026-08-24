# Rett fra Bonden — reviewer test instructions

Paste this block into the portal's "how should we test your connector" field.

```
No account, key or setup is needed. The server is public and unauthenticated — add
https://rettfrabonden.com/mcp and start asking. Answers come back in Norwegian or English,
whichever you ask in.

Try these four:

1. "Find local food producers near Bergen"
   -> lokal_search. Returns producers with their product catalogue and current prices.

2. "What organic cheese producers are there in Norway?"
   -> lokal_discover. Filters by category and certification (Debio-organic, Nyt Norge).

3. "When is the next Bondens marked farmers' market?"
   -> lokal_bm_next_markets. Returns upcoming market dates.

4. "Which producers belong to the REKO network?"
   -> lokal_list_umbrellas, then lokal_get_umbrella_members.

Please do NOT run lokal_cart_submit to completion during review. The three cart tools
(create / add item / submit) are real: a submitted cart is delivered to the producer as a
pickup request. Creating a cart and adding an item is harmless and demonstrates the write
path; submitting sends a real request to a real farm. No payment is involved at any step.
```

## Notes for us, not for the portal

- The four prompts above exercise 5 of the 14 tools. That is deliberate — the portal asks
  for a short review path, not full coverage.
- `lokal_geocode` is worth a fifth prompt ("what is near Voss?") if a reviewer asks how
  location search resolves place names.
- The cart caution mirrors the same warning already carried in
  `opplevagent-connectors-prep/chatgpt-app/README.md` for `book_gardssalg`: never drive a
  real write tool to completion against a real provider in a demo or review recording.
