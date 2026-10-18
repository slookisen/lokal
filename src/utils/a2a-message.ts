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
 */
export function a2aMessageData(message: unknown): unknown {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (m.data !== undefined && m.data !== null) return m.data;
  if (Array.isArray(m.parts)) {
    for (const p of m.parts) {
      if (!p || typeof p !== "object") continue;
      const part = p as Record<string, unknown>;
      if ((part.kind ?? part.type) !== "data") continue;
      if (part.data && typeof part.data === "object" && !Array.isArray(part.data)) return part.data;
    }
  }
  return m.data;
}
