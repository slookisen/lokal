// SPDX-License-Identifier: UNLICENSED
// Session-id handling test for the MCP JSON-RPC surface (rfb + dental).
//
// Regression coverage for: an unknown/expired Mcp-Session-Id must 404
// (never silently re-adopt a client-supplied id as a new session), and
// `initialize` must issue a session id the client didn't choose.
//
// This file is imported and driven by tests/test.ts (see
// runMcpSession404Tests below) as well as runnable standalone.

import assert from "node:assert";

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  assert.strictEqual(actual, expected, msg);
}
