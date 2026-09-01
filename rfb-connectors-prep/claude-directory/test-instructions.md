# Rett fra Bonden — reviewer test instructions

Paste this block into the portal's "how should we test your connector" field.

```
No account, key or setup is needed. The server is public and unauthenticated — add
https://rettfrabonden.com/mcp and start asking. Answers come back in Norwegian or English,
whichever you ask in.

Try these four:

1. "Find local food producers near Bergen"
   -> lokal_search. Returns producers with contact details and product names.

2. "What organic cheese producers are there in Norway?"
   -> lokal_discover. Filters by category and tag; `tags:["organic"]` and `tags:["debio"]`
      both return real results.

3. "When is the next Bondens marked farmers' market?"
   -> lokal_bm_next_markets. Returns upcoming market dates.

4. "Which food networks and markets exist in Norway?"
   -> lokal_list_umbrellas. Returns all 72 networks and venues (pass limit 200 to see
      them all; it defaults to 50 and truncates without saying so).

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
- **Prompt 4 is a SINGLE call, on purpose.** A previous draft chained
  `lokal_list_umbrellas` → `lokal_get_umbrella_members`, which a reviewer cannot complete:
  `lokal_get_umbrella_members` requires `umbrellaId` as a **UUID**, and no tool emits
  umbrella UUIDs — `lokal_list_umbrellas` returns names and profile URLs only, and slug or
  name values are rejected ("Fant ingen paraply med ID bondens-marked-oslo"). Its own
  schema says "Use lokal_list_umbrellas to find IDs", which is not currently true. Failing
  mid-chain in a demo is worse than an empty list, so the review path stays single-call
  until the server exposes the IDs. Routed to the dev-request queue.
- **Prompt 4 does NOT ask about REKO, on purpose.** An earlier draft did, and it would have
  returned nothing: `lokal_list_umbrellas` with `limit: 200` returns 72 umbrellas (14
  `market_network`, 57 `venue`, 1 `industry_org` — Hanen) and **zero** of them match
  "REKO". REKO rings exist in the catalogue as *producer* records (`lokal_search "REKO-ring"`
  returns 50+ at the default limit, tagged `reko`), not as umbrellas, so `lokal_get_umbrella_members` can never be
  pointed at one. Note also that `lokal_list_umbrellas` defaults to `limit: 50` and
  silently truncates — pass `limit: 200` when re-verifying this, or you will not see all 72.
- The cart caution states the rule directly rather than citing a precedent: never drive a
  real write tool to completion against a real provider in a demo or review recording. (An
  earlier draft attributed this warning to
  `opplevagent-connectors-prep/chatgpt-app/README.md`; that file on `main` contains no such
  warning and does not mention `book_gardssalg` at all. The equivalent caution is being
  added there by the still-open lokal#701 — do not cite it as existing until that merges.)
