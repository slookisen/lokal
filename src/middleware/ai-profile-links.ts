// ─── AI tagging of profile links at the transport boundary ─────────────
// dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 3 («Merking»).
//
// Every link to a profile page (rfb producer, dental clinic, experience,
// provider, gårdssalg producer) that we hand an AI client gets
// utm_source=<client>&utm_medium=mcp|a2a|api&utm_campaign=ai_search
// (tagAiProfileLinks in utils/url-utm.ts), so a person who clicks it in the
// AI's answer is counted as a click from an AI answer (profile-ai-clicks.ts).
//
// Tagging happens ONLY here, on what leaves through the transport:
//   - MCP: every tool result of a server (tagMcpToolResults);
//   - A2A: the JSON-RPC answer of POST /a2a (aiProfileLinksJson("a2a"));
//   - REST: JSON answers under the public APIs, only for an ai_search client
//     (ChatGPT-User, Claude-User, Perplexity-User …: classifyUA), which is how
//     custom GPT actions reach the API (aiProfileLinksForAiSearch).
// The shared link builders stay untagged: they also feed canonical, JSON-LD,
// sitemaps, e-mails, the shopping list and the pages.

import type { NextFunction, Request, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { classifyUA } from "../services/traffic-classifier";
import { aiClientFromHeaders, tagAiProfileLinks, type AiUtmMedium } from "../utils/url-utm";

type ToolExtra = { requestInfo?: { headers?: Record<string, string | string[] | undefined> } } | undefined;

/**
 * Wrap server.registerTool so every tool registered after this call returns
 * its result with tagged profile links. `clientIdentity` gives the session's
 * known client (detectMcpClient); otherwise the call's own headers and the
 * client name from `initialize` decide, else utm_source=ai_assistant.
 */
export function tagMcpToolResults(server: McpServer, clientIdentity?: () => string | undefined): void {
  const s = server as any;
  if (s.__aiProfileLinksTagged) return;
  s.__aiProfileLinksTagged = true;
  const register = s.registerTool.bind(server);
  s.registerTool = (name: string, config: unknown, cb: (...args: any[]) => unknown) =>
    register(name, config, async (...args: any[]) => {
      const result = await cb(...args);
      const extra = args[args.length - 1] as ToolExtra;
      const client = clientIdentity?.()
        ?? aiClientFromHeaders(extra?.requestInfo?.headers, s.server?.getClientVersion?.()?.name ?? null);
      return tagAiProfileLinks(result, client, "mcp");
    });
}

function wrapJson(req: Request, res: Response, medium: AiUtmMedium): void {
  const json = res.json.bind(res);
  const client = aiClientFromHeaders(req.headers as Record<string, string | string[] | undefined>);
  res.json = ((body: unknown) => {
    // A REST answer tagged for an AI must not be served to a person from a shared cache.
    if (medium === "api") res.vary("User-Agent");
    return json(tagAiProfileLinks(body, client, medium));
  }) as Response["json"];
}

/** Route middleware: the JSON answer (A2A JSON-RPC) gets tagged profile links. */
export function aiProfileLinksJson(medium: AiUtmMedium) {
  return (req: Request, res: Response, next: NextFunction): void => {
    wrapJson(req, res, medium);
    next();
  };
}

/** REST: tag profile links in JSON answers, only when the caller is an ai_search client. */
export function aiProfileLinksForAiSearch(req: Request, res: Response, next: NextFunction): void {
  if (classifyUA(String(req.headers["user-agent"] || "")) === "ai_search") wrapJson(req, res, "api");
  next();
}
