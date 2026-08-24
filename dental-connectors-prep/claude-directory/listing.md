# Finn tannlege — listing texts

Paste-ready. Character counts measured on the exact text in each block.

## Name (limit 100)

```
Finn tannlege
```
13 characters.

## Slug — PERMANENT after publication

```
finn-tannlege
```

Cannot be changed once the listing is published. Do not improvise a different one.

## Tagline (limit 55)

```
Search every dental clinic in Norway
```
36 characters (measured).

Alternative emphasising the differentiator:

```
Norwegian dentists: Helfo, specialty and emergency
```
50 characters (measured) — also inside the limit.

## Description (limit 2000)

```
finn-tannlege.com is an independent search service covering Norwegian dental clinics —
roughly 6,900 of them, from single-dentist practices to large clinics, across every
county.

Search by place, by specialty, or by the two things that actually change what a visit
costs and when you can get one: whether the clinic has a Helfo direct-billing agreement,
and whether it offers emergency duty (akuttvakt). Around 780 clinics have a Helfo
agreement and around 730 offer emergency duty, so both filters narrow a long list down to
something you can act on. Just over a thousand clinics have at least one registered
specialist, searchable by specialty.

Every record carries the clinic's address, contact details and county, so you can go
straight from "I need a dentist in Tromsø tonight" to a phone number.

The data comes from public sources — Brønnøysundregistrene, the Norwegian
health-personnel register (HPR), and the clinics' own websites — and is refreshed
continuously. The service is independent: it is not owned by, funded by, or affiliated
with any clinic or chain, and no clinic can pay for placement.

This connector is read-only and gives no dental advice. It tells you which clinics exist,
what they offer and how to reach them; the clinical conversation belongs with the dentist.
```
1292 characters (measured, newlines included). Well inside the 2000 limit.

The hard line wrapping is for this file's readability. Paste the block as-is — the portal
textarea keeps the paragraph breaks, which is what matters; the mid-paragraph wraps
collapse harmlessly on render.

## Categories

Primary: **Health** (or **Healthcare** / **Medical** if the portal words it that way).
Secondary: **Search** or **Reference** — the service is a directory, not a care provider.

## Copy rules for this listing

- **Do not** promise chain comparison. `tannlege_kjeder` exists and is correctly
  annotated, but live `chain_count` is `0` — no clinic is tagged to a chain today.
- **Do** keep the "no dental advice" sentence. A health-adjacent listing is read more
  strictly than a shopping one, and the disclaimer is true: the server returns directory
  records only.
- The clinic figure is given as "roughly 6,900" rather than the exact live 6,961, because
  the count moves daily and the listing text is not easy to edit afterwards. The exact
  figure belongs in `tannlege_stats` output, where it stays current on its own.

## Language note

The listing text is English because the directory audience is. The server itself answers
in Norwegian and English; `tannlege_search` accepts natural-language queries in either.
