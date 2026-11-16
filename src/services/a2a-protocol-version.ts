/**
 * a2a-protocol-version.ts — the ONE A2A protocol version this server speaks.
 *
 * A2A dev-request F1-4: every A2A agent card the server emits (RFB GET /a2a,
 * RFB /.well-known/agent-card.json + legacy /.well-known/agent.json and the
 * agent/authenticatedExtendedCard answer, Opplevagent and Finn-tannlege
 * GET /a2a + /.well-known/agent-card.json + /agent-card.json) reads its
 * `protocolVersion` from here.
 *
 * Why 0.3.0 and not 1.0.0: the cards used to say "1.0.0", but what they and
 * the handlers actually carry is A2A v0.3:
 *   - card shape: top-level `url` + `preferredTransport` + `additionalInterfaces`
 *     are v0.3 fields; v1.0 moved them into `supportedInterfaces[]`.
 *   - wire format: message/send (v0.3 method name) is the one method all three
 *     /a2a handlers answer (Opplevagent and Finn-tannlege answer nothing else),
 *     and the answers' parts carry the v0.3 `kind` discriminator. RFB also
 *     accepts the v1.0 names (SendMessage/GetTask/...) as aliases, but answers
 *     with the same v0.3 shapes.
 * Sources: https://a2a-protocol.org/latest/whats-new-v1/ and
 * https://a2a-protocol.org/latest/specification/
 *
 * Not the MCP protocol version (that is services/mcp-protocol-version.ts), and
 * not a card's own `version` (the agent's version).
 */
export const A2A_PROTOCOL_VERSION = "0.3.0";
