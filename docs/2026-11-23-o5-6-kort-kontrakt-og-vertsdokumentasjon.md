# O5-6 «kort i samtalen» — notes for the PR body

## Host docs read on build day (2026-11-23)

Read live with WebFetch:
- Claude: https://claude.com/docs/connectors/building/mcp-apps/getting-started (section "Set `ui.domain` for Claude",
  "Register tools and resources once for every host") and .../mcp-apps/troubleshooting ("`ui.domain` validation fails").
- OpenAI: https://developers.openai.com/apps-sdk/reference and https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt.
- MCP Apps spec 2026-01-26 (github ext-apps, specification/2026-01-26/apps.mdx).

Findings:
1. Both hosts implement the same MCP Apps standard: `text/html;profile=mcp-app` resource, tool `_meta.ui.resourceUri`,
   card reads `structuredContent`, `ui/message` / `ui/open-link` bridge. Claude: "An MCP App can run in Claude and in other
   hosts that support MCP Apps from one codebase … One thing that differs is `ui.domain`: each host has its own format."
2. `ui.domain`: Claude validates it against the connector URL and, when it is anything but
   `<first 32 hex of sha256(server URL)>.claudemcpcontent.com`, shows an error *instead of the app* (web, Desktop).
   The spec says `ui.domain` is optional; omitted, the host uses its default sandbox origin.
   OpenAI: the dedicated origin is "required when submitting a plugin with UI"; `openai/widgetDomain` is the
   "OpenAI-specific compatibility alias for `_meta.ui.domain` in ChatGPT".
3. CSP: `_meta.ui.csp` (`connectDomains`, `resourceDomains`) is the shared key; ChatGPT still needs the legacy
   `openai/widgetCSP.redirect_domains` for trusted `openExternal` targets.

Decision — one setup for both hosts:
- The two new card resources carry **no `ui.domain`** (so Claude renders them in its default sandbox) and carry ChatGPT's
  dedicated origin only under its own alias `openai/widgetDomain: "https://opplevagent.no"` (Claude ignores `openai/*`).
- CSP: `ui.csp` with empty `connectDomains`/`resourceDomains`; `openai/widgetCSP` empty lists + `redirect_domains:
  ["https://opplevagent.no"]`. The HTML loads nothing (inline CSS/JS, no url(), no src=).
- Not verified in a live host (session step): (a) that ChatGPT's submission check accepts `openai/widgetDomain` alone
  without `_meta.ui.domain` — the reference calls it an alias, but does not say so outright; (b) rendering in Claude.
  If (a) fails, the fallback is to add `ui.domain: "https://opplevagent.no"` back (ChatGPT format) and leave Claude on
  the text answer, as the spec allows. The existing experience cards (WIDGET_LIST_URI / WIDGET_DETAIL_URI) are NOT
  changed here: they still send `ui.domain: "https://opplevagent.no"` (grunnlag 05 §5 R8 stays open for them; changing
  them would change the frozen contract).
- Note (Claude Code, grunnlag 05 U11): a host that reads only structuredContent gets it instead of the text. The
  structuredContent is therefore the whole text payload plus a `card` key, so nothing is lost there.

## Contract (tools/list) — flag `GARDSSALG_MCP_CARDS_ENABLED`

- Flag off (default): tools/list, resources/list and every tool result byte-identical to main db7d8df (golden hashes in
  the new test, with every other O5 flag off and with them on).
- Flag on: tools/list changes ONLY by `_meta` on `discover_gardssalg`, `book_gardssalg` and (when its own flag is on)
  `get_gardssalg_booking`:
  `"_meta": { "ui": { "resourceUri": <card uri> }, "openai/outputTemplate": <card uri> }`. No outputSchema, no
  input/description/annotation change. resources/list gains two resources:
  `ui://opplevagent/gardssalg-producers-2026-11-23` and `ui://opplevagent/gardssalg-booking-2026-11-23`.
- The resources' `openai/widgetDescription` texts are new English model-facing texts (not in OA-2, which covers what the
  card shows). They are in `src/routes/experiences-mcp.ts` (registerCardResource calls) for Daniel to approve:
  - list: "A list of the gårdssalg producers the assistant just found: name, type of place, municipality and whether it takes visit requests, with a Request a visit button and a link to the profile page. The assistant should summarise briefly rather than repeat every producer."
  - booking: "A summary of one visit request: producer, time, number of guests, status and a link to the guest's status page. In a preview it shows what will be sent, and to whom; nothing has been sent."

### Changed tool definitions, verbatim — cards flag on, every other O5 flag off (today's prod flag state)

```json
[
  {
    "name": "discover_gardssalg",
    "title": "Find drink producers to visit for a tasting (gårdssalg)",
    "description": "Use this to plan a visit or tasting at a Norwegian drink producer (brewery, cidery, winery, distillery, meadery, farm café) and find ones that accept visit requests; it does not sell or order products. It searches opplevagent.no's gårdssalg (farm-sale) vertical of Brreg-registered drink producers to visit (besøk, smaking) (bryggeri/sideri/vingård/destilleri/mjøderi/gårdskafé/seltzeri). Finn norske gårdssalg-produsenter (drikkeprodusenter som selger direkte fra gården) etter fylke, kommune og produsenttype. / Filter by county (fylke), municipality (kommune), and producer type. Also supports near-me search via lat/lng (+ optional radius_km): when given, results include a rounded distance_km and are sorted nearest-first, and rows with no geocoded location are excluded (never a fabricated distance). Returns id (the provider_id for book_gardssalg), name, location, producer type, profile_url, and an honest booking status (live direct booking vs. a dark-launch 'coming soon' note — never overclaims booking availability). Include each returned producer's profile_url as a clickable link when available; when booking is paused, tell the user to contact the producer via that profile page. To look up ONE specific producer by name (e.g. when the guest says 'book hos Fjordgard Bryggeri'), pass `query`. Examples: 'gårdssalg i Vestland', 'cideri near lat 60.4 / lng 5.3', 'bryggeri med booking', query: 'Fjordgard Bryggeri'.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "fylke": {
          "description": "Norwegian county (fylke) of the producer. Examples: 'Oslo', 'Vestland', 'Troms', 'Rogaland'",
          "type": "string"
        },
        "kommune": {
          "description": "Norwegian municipality (kommune) of the producer. Examples: 'Tromsø', 'Bergen', 'Stavanger'",
          "type": "string"
        },
        "producer_type": {
          "description": "Type of drink producer — one of the six canonical drink venue kinds: 'bryggeri' (brewery), 'cideri' (cidery), 'vingård' (winery), 'destilleri' (distillery), 'gårdskafé' (farm café), 'mjød'/'mjøderi' (meadery). 'seltzeri' also occurs in the data.",
          "type": "string"
        },
        "query": {
          "description": "Free-text lookup of a specific producer by name and/or place, e.g. 'Fjordgard Bryggeri', 'Egge gård', 'sideri Hardanger'. Every word must match the producer's name, URL slug, place (poststed) or municipality; exact name matches rank first. Use this to get the `id` (provider_id) for book_gardssalg when the guest names a producer. A county name in the query (e.g. 'Vestland') is applied as the fylke filter; for a whole county, prefer fylke.",
          "type": "string",
          "maxLength": 200
        },
        "booking_live": {
          "description": "When true, only return producers that currently accept direct bookings. Omit to include producers regardless of booking status.",
          "type": "boolean"
        },
        "lat": {
          "description": "Origin latitude for a near-me search (decimal degrees). Must be given together with lng. Example: 69.65 (Tromsø)",
          "type": "number",
          "minimum": -90,
          "maximum": 90
        },
        "lng": {
          "description": "Origin longitude for a near-me search (decimal degrees). Must be given together with lat. Example: 18.95 (Tromsø)",
          "type": "number",
          "minimum": -180,
          "maximum": 180
        },
        "radius_km": {
          "description": "Max distance from lat/lng in kilometers. Only applies when lat/lng are given. Example: 50",
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 5000
        },
        "limit": {
          "default": 20,
          "description": "Max results (default 20, max 50)",
          "type": "number",
          "minimum": 1,
          "maximum": 50
        }
      }
    },
    "annotations": {
      "title": "Discover gårdssalg producers",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    },
    "_meta": {
      "ui": {
        "resourceUri": "ui://opplevagent/gardssalg-producers-2026-11-23"
      },
      "openai/outputTemplate": "ui://opplevagent/gardssalg-producers-2026-11-23"
    }
  },
  {
    "name": "book_gardssalg",
    "title": "Request a visit or tasting at a drink producer (pending until the producer replies)",
    "description": "Use this to request a visit or tasting (besøk, smaking) at a Norwegian gårdssalg drink producer found with discover_gardssalg or named by the guest; it sends a visit request and does not sell or order products. Send inn en reservasjonsforespørsel for et gårdssalg-besøk. IMPORTANT: this NEVER creates a confirmed booking — it creates a PENDING request, exactly like the producer's own website form. The PRODUCER reviews the request and responds (confirms, proposes another time, or declines); guest_email only receives a read-only status link, never anything that can finalize the booking. No payment is involved (pickup/visit, pay on arrival, as today). Only producers with an active booking status (see discover_gardssalg's booking.live field) can be booked — a paused/not-yet-onboarded producer is rejected with a clear message, never a silent failure. VIKTIG: oppretter ALDRI en bekreftet booking — kun en avventende forespørsel; produsenten mottar forespørselen og svarer (bekrefter, foreslår nytt tidspunkt eller avslår). ONE-SENTENCE FLOW («book et møte hos X fredag 20. oktober kl. 10 for 4 personer»): call this ONCE with provider_query='X' (the producer's name — no discover_gardssalg round-trip needed), slot_at, party_size, guest_name, guest_email and requested_weekday='fredag'. The tool resolves X to exactly one producer (or returns candidates / not-found with NO booking created), checks that the date really is a Friday (or returns weekday_mismatch:true with the nearest Fridays, NO booking created), then submits the request and notifies the producer by email. guest_name and guest_email are the HUMAN guest's own — ask the guest for them if you do not have them; never invent or reuse someone else's. Required: provider_id OR provider_query, slot_at (requested date/time, 'YYYY-MM-DDTHH:MM' Europe/Oslo), party_size, guest_name, guest_email. Optional: requested_weekday, experience_id, guest_phone, notes, confirm_outside_hours. The requested slot_at is ALWAYS hard-rejected if it's in the past or too far ahead. If the producer has stated opening hours and slot_at falls outside them, this returns outside_hours:true (not an error) and creates no booking — retry once with confirm_outside_hours:true if the exact requested time should be kept anyway. On success the response carries the resolved producer (provider.navn) and slot_at_local (e.g. 'fredag 23. oktober 2026 kl. 10:00') — read both back to the guest. Example: provider_query 'Fjordgard Bryggeri', slot_at '2026-10-23T10:00', requested_weekday 'fredag', party_size 4, guest_name 'Kari Nordmann', guest_email 'kari@example.no'.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "provider_id": {
          "description": "The gårdssalg producer's id — the `id` field of a discover_gardssalg result (NOT the profile slug). Example: '3f1b2c4d-...'. Either provider_id or provider_query is required; provider_id wins when both are given.",
          "type": "string"
        },
        "provider_query": {
          "description": "Alternative to provider_id: the producer's name as the guest said it, optionally with a place, e.g. 'Fjordgard Bryggeri' or 'Egge gård Steinkjer'. Resolved to exactly ONE producer; if several match, the tool returns the candidates (no booking created) so you can ask the guest which one; if none match, it says so.",
          "type": "string",
          "maxLength": 200
        },
        "requested_weekday": {
          "description": "Safety check — the weekday the guest actually said, e.g. 'fredag' or 'Friday'. If slot_at does not fall on that weekday (Europe/Oslo) the tool returns weekday_mismatch:true with the nearest dates that do, instead of booking the wrong day. Always pass it when the guest named a weekday.",
          "type": "string",
          "maxLength": 20
        },
        "experience_id": {
          "description": "Optional experience UUID if this booking is for a specific listed experience rather than a general gårdssalg visit.",
          "type": "string"
        },
        "slot_at": {
          "type": "string",
          "description": "Requested visit date/time, local (Europe/Oslo), format 'YYYY-MM-DDTHH:MM'. Example: '2026-08-15T13:00'. This is a REQUEST — the producer may confirm, suggest another time, or decline."
        },
        "party_size": {
          "type": "number",
          "description": "Number of people in the group (1-50). Example: 4"
        },
        "guest_name": {
          "type": "string",
          "description": "Full name of the person the reservation is for. Example: 'Kari Nordmann'"
        },
        "guest_email": {
          "type": "string",
          "description": "Guest's email address — REQUIRED. Receives a confirmation-of-request email plus a read-only status link; the booking stays pending until the PRODUCER responds (confirms, proposes another time, or declines) — the guest's link cannot finalize anything. Example: 'kari@example.no'"
        },
        "guest_phone": {
          "description": "Optional guest phone number.",
          "type": "string"
        },
        "notes": {
          "description": "Optional free-text note to the producer (e.g. dietary needs, arrival details).",
          "type": "string"
        },
        "confirm_outside_hours": {
          "description": "Set to true only when RETRYING after a previous call to this tool returned outside_hours:true and the requested time should be kept anyway, despite falling outside the producer's stated opening hours. Omit on a first attempt.",
          "type": "boolean"
        }
      },
      "required": [
        "slot_at",
        "party_size",
        "guest_name",
        "guest_email"
      ]
    },
    "annotations": {
      "title": "Request a gårdssalg booking",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    },
    "execution": {
      "taskSupport": "forbidden"
    },
    "_meta": {
      "ui": {
        "resourceUri": "ui://opplevagent/gardssalg-booking-2026-11-23"
      },
      "openai/outputTemplate": "ui://opplevagent/gardssalg-booking-2026-11-23"
    }
  }
]
```

### Changed tool definitions, verbatim — cards flag on with GUEST_REF, PREVIEW, STATUS_TOOL and VISIT_FACTS on

```json
[
  {
    "name": "discover_gardssalg",
    "title": "Find drink producers in Norway that accept visit requests (gårdssalg)",
    "description": "Use this to plan a visit to a Norwegian drink producer (brewery, cidery, winery, distillery, meadery, farm café) and find ones that accept visit requests; it does not sell or order products. It searches opplevagent.no's gårdssalg (farm-sale) vertical of Brreg-registered drink producers to visit (besøk) (bryggeri/sideri/vingård/destilleri/mjøderi/gårdskafé/seltzeri). Finn norske gårdssalg-produsenter (drikkeprodusenter som selger direkte fra gården) etter fylke, kommune og produsenttype. / Filter by county (fylke), municipality (kommune), and producer type. Also supports near-me search via lat/lng (+ optional radius_km): when given, results include a rounded distance_km and are sorted nearest-first, and rows with no geocoded location are excluded (never a fabricated distance). Returns id (the provider_id for book_gardssalg), name, location, producer type, profile_url, and an honest booking status (live direct booking vs. a dark-launch 'coming soon' note — never overclaims booking availability). Include each returned producer's profile_url as a clickable link when available; when booking is paused, tell the user to contact the producer via that profile page. To look up ONE specific producer by name (e.g. when the guest says 'book hos Fjordgard Bryggeri'), pass `query`. Examples: 'gårdssalg i Vestland', 'cideri near lat 60.4 / lng 5.3', 'bryggeri med booking', query: 'Fjordgard Bryggeri'.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "fylke": {
          "description": "Norwegian county (fylke) of the producer. Examples: 'Oslo', 'Vestland', 'Troms', 'Rogaland'",
          "type": "string"
        },
        "kommune": {
          "description": "Norwegian municipality (kommune) of the producer. Examples: 'Tromsø', 'Bergen', 'Stavanger'",
          "type": "string"
        },
        "producer_type": {
          "description": "Type of drink producer — one of the six canonical drink venue kinds: 'bryggeri' (brewery), 'cideri' (cidery), 'vingård' (winery), 'destilleri' (distillery), 'gårdskafé' (farm café), 'mjød'/'mjøderi' (meadery). 'seltzeri' also occurs in the data.",
          "type": "string"
        },
        "query": {
          "description": "Free-text lookup of a specific producer by name and/or place, e.g. 'Fjordgard Bryggeri', 'Egge gård', 'sideri Hardanger'. Every word must match the producer's name, URL slug, place (poststed) or municipality; exact name matches rank first. Use this to get the `id` (provider_id) for book_gardssalg when the guest names a producer. A county name in the query (e.g. 'Vestland') is applied as the fylke filter; for a whole county, prefer fylke.",
          "type": "string",
          "maxLength": 200
        },
        "booking_live": {
          "description": "When true, only return producers that currently accept direct bookings. Omit to include producers regardless of booking status.",
          "type": "boolean"
        },
        "lat": {
          "description": "Origin latitude for a near-me search (decimal degrees). Must be given together with lng. Example: 69.65 (Tromsø)",
          "type": "number",
          "minimum": -90,
          "maximum": 90
        },
        "lng": {
          "description": "Origin longitude for a near-me search (decimal degrees). Must be given together with lat. Example: 18.95 (Tromsø)",
          "type": "number",
          "minimum": -180,
          "maximum": 180
        },
        "radius_km": {
          "description": "Max distance from lat/lng in kilometers. Only applies when lat/lng are given. Example: 50",
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 5000
        },
        "limit": {
          "default": 20,
          "description": "Max results (default 20, max 50)",
          "type": "number",
          "minimum": 1,
          "maximum": 50
        }
      }
    },
    "annotations": {
      "title": "Discover gårdssalg producers",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    },
    "_meta": {
      "ui": {
        "resourceUri": "ui://opplevagent/gardssalg-producers-2026-11-23"
      },
      "openai/outputTemplate": "ui://opplevagent/gardssalg-producers-2026-11-23"
    }
  },
  {
    "name": "book_gardssalg",
    "title": "Request a visit at a drink producer (pending until the producer replies)",
    "description": "Use this to request a visit (besøk) at a Norwegian gårdssalg drink producer found with discover_gardssalg or named by the guest; it sends a visit request and does not sell or order products. Send inn en reservasjonsforespørsel for et gårdssalg-besøk. IMPORTANT: this NEVER creates a confirmed booking — it creates a PENDING request, exactly like the producer's own website form. The PRODUCER reviews the request and responds (confirms, proposes another time, or declines); guest_email only receives a read-only status link, never anything that can finalize the booking. No payment is involved (pickup/visit, pay on arrival, as today). Only producers with an active booking status (see discover_gardssalg's booking.live field) can be booked — a paused/not-yet-onboarded producer is rejected with a clear message, never a silent failure. VIKTIG: oppretter ALDRI en bekreftet booking — kun en avventende forespørsel; produsenten mottar forespørselen og svarer (bekrefter, foreslår nytt tidspunkt eller avslår). ONE-SENTENCE FLOW («book et møte hos X fredag 20. oktober kl. 10 for 4 personer»): call this ONCE with provider_query='X' (the producer's name — no discover_gardssalg round-trip needed), slot_at, party_size, guest_name, guest_email and requested_weekday='fredag'. The tool resolves X to exactly one producer (or returns candidates / not-found with NO booking created), checks that the date really is a Friday (or returns weekday_mismatch:true with the nearest Fridays, NO booking created), then submits the request and notifies the producer by email. guest_name and guest_email are the HUMAN guest's own — ask the guest for them if you do not have them; never invent or reuse someone else's. Required: provider_id OR provider_query, slot_at (requested date/time, 'YYYY-MM-DDTHH:MM' Europe/Oslo), party_size, guest_name, guest_email. Optional: requested_weekday, experience_id, guest_phone, notes, confirm_outside_hours. The requested slot_at is ALWAYS hard-rejected if it's in the past or too far ahead. If the producer has stated opening hours and slot_at falls outside them, this returns outside_hours:true (not an error) and creates no booking — retry once with confirm_outside_hours:true if the exact requested time should be kept anyway. On success the response carries the resolved producer (provider.navn) and slot_at_local (e.g. 'fredag 23. oktober 2026 kl. 10:00') — read both back to the guest. Example: provider_query 'Fjordgard Bryggeri', slot_at '2026-10-23T10:00', requested_weekday 'fredag', party_size 4, guest_name 'Kari Nordmann', guest_email 'kari@example.no'. With preview: true the tool runs every check and returns the summary the guest should see, without storing or sending anything. On success the response carries guest_ref and status_url. Keep guest_ref for this conversation: it is needed to check the status or cancel with get_gardssalg_booking and cancel_gardssalg_booking. The response also lists what is shared with the producer and links to the privacy policy.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "provider_id": {
          "description": "The gårdssalg producer's id — the `id` field of a discover_gardssalg result (NOT the profile slug). Example: '3f1b2c4d-...'. Either provider_id or provider_query is required; provider_id wins when both are given.",
          "type": "string"
        },
        "provider_query": {
          "description": "Alternative to provider_id: the producer's name as the guest said it, optionally with a place, e.g. 'Fjordgard Bryggeri' or 'Egge gård Steinkjer'. Resolved to exactly ONE producer; if several match, the tool returns the candidates (no booking created) so you can ask the guest which one; if none match, it says so.",
          "type": "string",
          "maxLength": 200
        },
        "requested_weekday": {
          "description": "Safety check — the weekday the guest actually said, e.g. 'fredag' or 'Friday'. If slot_at does not fall on that weekday (Europe/Oslo) the tool returns weekday_mismatch:true with the nearest dates that do, instead of booking the wrong day. Always pass it when the guest named a weekday.",
          "type": "string",
          "maxLength": 20
        },
        "experience_id": {
          "description": "Optional experience UUID if this booking is for a specific listed experience rather than a general gårdssalg visit.",
          "type": "string"
        },
        "slot_at": {
          "type": "string",
          "description": "Requested visit date/time, local (Europe/Oslo), format 'YYYY-MM-DDTHH:MM'. Example: '2026-08-15T13:00'. This is a REQUEST — the producer may confirm, suggest another time, or decline."
        },
        "party_size": {
          "type": "number",
          "description": "Number of people in the group (1-50). Example: 4"
        },
        "guest_name": {
          "type": "string",
          "description": "Full name of the person the reservation is for. Example: 'Kari Nordmann'"
        },
        "guest_email": {
          "type": "string",
          "description": "Guest's email address — REQUIRED. Receives a confirmation-of-request email plus a read-only status link; the booking stays pending until the PRODUCER responds (confirms, proposes another time, or declines) — the guest's link cannot finalize anything. Example: 'kari@example.no'"
        },
        "guest_phone": {
          "description": "Optional guest phone number.",
          "type": "string"
        },
        "notes": {
          "description": "Optional free-text note to the producer (e.g. dietary needs, arrival details).",
          "type": "string"
        },
        "confirm_outside_hours": {
          "description": "Set to true only when RETRYING after a previous call to this tool returned outside_hours:true and the requested time should be kept anyway, despite falling outside the producer's stated opening hours. Omit on a first attempt.",
          "type": "boolean"
        },
        "preview": {
          "description": "Set to true to run every check and return the summary the guest should see, without storing or sending anything. Omit to send the request.",
          "type": "boolean"
        }
      },
      "required": [
        "slot_at",
        "party_size",
        "guest_name",
        "guest_email"
      ]
    },
    "annotations": {
      "title": "Request a gårdssalg booking",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    },
    "execution": {
      "taskSupport": "forbidden"
    },
    "_meta": {
      "ui": {
        "resourceUri": "ui://opplevagent/gardssalg-booking-2026-11-23"
      },
      "openai/outputTemplate": "ui://opplevagent/gardssalg-booking-2026-11-23"
    }
  },
  {
    "name": "get_gardssalg_booking",
    "title": "Check the status of a visit request",
    "description": "Use this to look up a visit request made with book_gardssalg. It returns the current status (waiting for the producer, confirmed, new time suggested, declined, expired or cancelled), the agreed or suggested time, the reply deadline, the guest's own status page and, when the producer has suggested a new time, the link where the guest replies. It needs the reference and the guest_ref that book_gardssalg returned. It only reads and never changes the request. If the reference and guest_ref do not match a request, it answers that the request was not found.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "booking_ref": {
          "type": "string",
          "maxLength": 200,
          "description": "booking_ref from the book_gardssalg result."
        },
        "guest_ref": {
          "type": "string",
          "maxLength": 200,
          "description": "guest_ref from the book_gardssalg result."
        }
      },
      "required": [
        "booking_ref",
        "guest_ref"
      ]
    },
    "annotations": {
      "title": "Get visit request status",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    },
    "_meta": {
      "ui": {
        "resourceUri": "ui://opplevagent/gardssalg-booking-2026-11-23"
      },
      "openai/outputTemplate": "ui://opplevagent/gardssalg-booking-2026-11-23"
    }
  }
]
```
