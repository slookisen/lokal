import { capFreeText, capNameList, MAX_NAME_LIST_ITEMS } from "./free-text";

/**
 * The structured data of an A2A message, shared by the three message/send
 * handlers: RFB (routes/a2a.ts), Opplevagent (routes/experiences-a2a.ts) and
 * Finn-tannlege (routes/dental-a2a.ts).
 *
 * dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-X (FUNN
 * dental-a2a-datapart-ignoreres): the A2A standard sends structured data as
 * a DataPart, `message.parts: [{kind: "data", data: {…}}]`, but the handlers
 * read only the non-standard `message.data`. They now read this instead, so
 * a DataPart is used exactly as `message.data` is:
 *   - `message.data` wins when the message has both;
 *   - otherwise the data of the first DataPart whose `data` is an object
 *     (A2A's DataPart carries an object; a string or an array is skipped).
 *     The discriminator is `kind`, or `type` for older clients;
 *   - a message with neither gives `message.data` itself (undefined, or a
 *     null the caller sent), so every handler answers it as before.
 * Text keeps the place it has in each handler: this reads data only.
 *
 * Slice I-Y2 (FUNN a2a-datapart-strengfelt-uten-lengdetak): the data comes
 * back with its strings cut (capA2aData), as the message text is. A field of
 * 1 MB (dental `fylke`, RFB `query`) went whole to the search, the logs and
 * the answer, which echoes it.
 */
export function a2aMessageData(message: unknown): unknown {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (m.data !== undefined && m.data !== null) return capA2aData(m.data);
  if (Array.isArray(m.parts)) {
    for (const p of m.parts) {
      if (!p || typeof p !== "object") continue;
      const part = p as Record<string, unknown>;
      if ((part.kind ?? part.type) !== "data") continue;
      if (part.data && typeof part.data === "object" && !Array.isArray(part.data)) return capA2aData(part.data);
    }
  }
  return m.data;
}

/**
 * The most entries of a list in the data that are read (slice I-Y2). The
 * lists the handlers read are RFB's `categories`, `tags` and `skills`. Since
 * slice I-Y3 the cut is utils/free-text.ts's capNameList, which MCP
 * lokal_discover and POST /api/marketplace/discover use too.
 */
export const MAX_A2A_DATA_LIST_ITEMS = MAX_NAME_LIST_ITEMS;

/** A string cut to MAX_FREE_TEXT_CHARS (utils/free-text.ts); any other value as it is. */
function capString(v: unknown): unknown {
  return typeof v === "string" ? capFreeText(v) : v;
}

/**
 * The data with its strings cut (slice I-Y2): a string, the string values of
 * an object and the lists among them (capNameList: the first
 * MAX_A2A_DATA_LIST_ITEMS entries, each string a name cut to MAX_NAME_CHARS).
 * The handlers read no string deeper than that, so a nested object is kept
 * as it is. Data within the caps is returned as the same value, so every
 * such message answers as before. This bounds each field; the message as a
 * whole is bounded by the body limit (express.json, 1 MB), and what RFB A2A
 * logs, stores and echoes of it by boundedA2aQuery() in routes/a2a.ts
 * (slice I-Y3).
 */
export function capA2aData(data: unknown): unknown {
  if (typeof data === "string") return capFreeText(data);
  if (Array.isArray(data)) return capNameList(data);
  if (!data || typeof data !== "object") return data;
  let changed = false;
  const entries = Object.entries(data as Record<string, unknown>).map(([key, value]) => {
    const capped = Array.isArray(value) ? capNameList(value) : capString(value);
    if (capped !== value) changed = true;
    return [key, capped] as const;
  });
  // fromEntries defines each key as an own property, also a `__proto__` key
  // from the JSON body, which an assignment would take as the prototype.
  return changed ? Object.fromEntries(entries) : data;
}
