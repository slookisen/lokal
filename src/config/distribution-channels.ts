// ─── Distribution channels: ONE source for the three agent cards ────────────
// Each vertical's `x-distribution` (rfb marketplace-registry, dental-agent-card,
// experiences-agent-card) is mapped from this list (A2A dev-request
// 2026-10-16-distribusjon-synk, slice G1-S4). `probe` is exactly what the
// visibility routine should fetch to check the channel; `verifiedAt` is the date
// the URL last answered. No version numbers or catalogue counts in `description`
// (they go stale — the numbers live in distribution/catalog-claims.json).
//
// `install: AGENT_CARD` means "the vertical's own /.well-known/agent-card.json",
// resolved per request by `distributionFor`.

export type DistributionVertical = "rfb" | "dental" | "experiences";

export const AGENT_CARD = "agent-card" as const;

export interface DistributionChannel {
  channel: string;
  url: string;
  install: string;
  status: "live";
  description: string;
  verifiedAt: string;
  probe: { url: string; expect: number };
}

type Entry = Omit<DistributionChannel, "status" | "verifiedAt" | "probe"> & {
  verifiedAt?: string;
};

// Opplevagent's ChatGPT Custom GPT — also linked from the homepage (experiences-seo.ts).
export const OPPLEVAGENT_CUSTOM_GPT_URL =
  "https://chatgpt.com/g/g-6a3ab590a7f081919c528a15c6765a7d-opplevagent-finn-opplevelser-i-norge";

const VERIFIED = "2026-10-16";
const STDIO_DESC = "Stdio-transport package for local Claude Desktop / Cursor / Cline installs.";
const A2A_DESC = "A2A protocol registry listing — direct JSON-RPC at /a2a.";

const RFB_GPT = "https://chatgpt.com/g/g-69dbf8593c1c81919050f8da98cd327d-rett-fra-bonden";
const DENTAL_GPT = "https://chatgpt.com/g/g-6a21e79241cc8191a04642bda508e42b-finn-tannlege-i-norge";

const CHANNELS: Record<DistributionVertical, Entry[]> = {
  rfb: [
    {
      channel: "smithery",
      url: "https://smithery.ai/servers/@slookisen/rettfrabonden",
      install: "https://server.smithery.ai/@slookisen/rettfrabonden",
      description: "Public Smithery listing of the lokal MCP server (rett-fra-bonden). Reads are open; writes require X-API-Key.",
    },
    {
      channel: "npm",
      url: "https://www.npmjs.com/package/lokal-mcp",
      install: "npx lokal-mcp",
      description: STDIO_DESC,
    },
    {
      channel: "a2a-registry",
      url: "https://a2aregistry.org/agents/00157ca1-450f-4341-91a5-dbcab7a667ef/",
      install: AGENT_CARD,
      description: A2A_DESC,
    },
    {
      channel: "official-mcp-registry",
      url: "https://registry.modelcontextprotocol.io/v0/servers?search=lokal",
      install: "npx lokal-mcp",
      description: "Official Model Context Protocol Registry — io.github.slookisen/lokal-mcp.",
    },
    {
      channel: "glama",
      url: "https://glama.ai/mcp/servers/slookisen/lokal",
      install: "npx lokal-mcp",
      description: "Glama MCP servers directory listing.",
    },
    {
      channel: "mcp-so",
      url: "https://mcp.so/servers/rett-fra-bonden-lokal",
      install: "npx lokal-mcp",
      description: "mcp.so MCP servers directory listing.",
    },
    {
      channel: "custom-gpt",
      url: RFB_GPT,
      install: RFB_GPT,
      description: "ChatGPT Custom GPT — Rett fra Bonden local-food discovery; Actions on rettfrabonden.com/openapi.yaml.",
    },
    {
      channel: "agenstry",
      url: "https://agenstry.com/agents/rettfrabonden.com",
      install: AGENT_CARD,
      description: "Agenstry A2A agent directory — auto-indexed from agent-card.json; drift-monitored.",
    },
  ],
  dental: [
    {
      channel: "custom-gpt",
      url: DENTAL_GPT,
      install: DENTAL_GPT,
      description: "ChatGPT Custom GPT — Finn tannlege i Norge clinic discovery; Actions on finn-tannlege.com/openapi.json.",
    },
    {
      channel: "npm",
      url: "https://www.npmjs.com/package/finn-tannlege-mcp",
      install: "npx finn-tannlege-mcp",
      description: STDIO_DESC,
    },
    {
      channel: "official-mcp-registry",
      url: "https://registry.modelcontextprotocol.io/v0/servers?search=finn-tannlege",
      install: "npx finn-tannlege-mcp",
      description: "Official Model Context Protocol Registry — io.github.slookisen/finn-tannlege-mcp.",
    },
    {
      channel: "glama",
      url: "https://glama.ai/mcp/connectors/com.finn-tannlege/finn-tannlege",
      install: "npx finn-tannlege-mcp",
      description: "Glama MCP servers directory listing.",
    },
    {
      channel: "mcp-so",
      url: "https://mcp.so/servers/finn-tannlege",
      install: "npx finn-tannlege-mcp",
      description: "mcp.so MCP servers directory listing.",
    },
    {
      channel: "a2a-registry",
      url: "https://a2aregistry.org/agents/cd035cbe-46f9-4591-889e-e4fa20663113/",
      install: AGENT_CARD,
      description: A2A_DESC,
    },
    {
      channel: "agenstry",
      url: "https://agenstry.com/agents/finn-tannlege.com",
      install: AGENT_CARD,
      description: "Agenstry A2A agent directory — auto-indexed from agent-card.json.",
    },
  ],
  experiences: [
    {
      channel: "custom-gpt",
      url: OPPLEVAGENT_CUSTOM_GPT_URL,
      install: OPPLEVAGENT_CUSTOM_GPT_URL,
      description: "ChatGPT Custom GPT — Opplevagent experiences discovery; 3 Actions on opplevagent.no/openapi.json (discover/categories/get).",
    },
    {
      channel: "npm",
      url: "https://www.npmjs.com/package/opplevagent-mcp",
      install: "npx opplevagent-mcp",
      description: STDIO_DESC,
    },
    {
      channel: "official-mcp-registry",
      url: "https://registry.modelcontextprotocol.io/v0/servers?search=opplevagent",
      install: "npx opplevagent-mcp",
      description: "Official Model Context Protocol Registry — io.github.slookisen/opplevagent-mcp.",
    },
    {
      channel: "mcp-so",
      url: "https://mcp.so/servers/opplevagent-mcp",
      install: "npx opplevagent-mcp",
      description: "mcp.so MCP servers directory listing.",
    },
    {
      channel: "a2a-registry",
      url: "https://a2aregistry.org/agents/38eee4e2-cb59-4562-90d1-416ce91ca2bd/",
      install: AGENT_CARD,
      description: A2A_DESC,
    },
    {
      channel: "agenstry",
      url: "https://agenstry.com/agents/opplevagent.no",
      install: AGENT_CARD,
      description: "Agenstry A2A agent directory — auto-indexed from agent-card.json.",
    },
  ],
};

/** The `x-distribution` list for one vertical; `agentCardUrl` fills `install: AGENT_CARD`. */
export function distributionFor(vertical: DistributionVertical, agentCardUrl: string): DistributionChannel[] {
  return CHANNELS[vertical].map((e) => ({
    channel: e.channel,
    url: e.url,
    install: e.install === AGENT_CARD ? agentCardUrl : e.install,
    status: "live" as const,
    description: e.description,
    verifiedAt: e.verifiedAt ?? VERIFIED,
    probe: { url: e.url, expect: 200 },
  }));
}
