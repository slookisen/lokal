/**
 * mcp-protocol-version.test.ts — dev-request
 * 2026-07-13-mcp-2026-spec-server-card.md, criterion 3.
 *
 * The 2026-07-28 spec removes the `initialize` handshake in favour of
 * per-request `_meta` and adds a mandatory `server/discover`. There is no
 * fall-forward in either direction, so "which era does this endpoint speak" is
 * now a question a client MUST answer before connecting — and our discovery
 * surfaces did not answer it. Measured on all three live domains 2026-07-29:
 * `protocolVersion` absent from every server-card, and `/.well-known/mcp`
 * advertising `2025-06-18` while prod actually negotiated up to `2025-11-25`.
 *
 *   mpv1-mpv6    eraOf is a total ordering on the date-stamped versions, and
 *                the boundary is exactly 2026-07-28.
 *   mpv7-mpv13   The declaration is DERIVED from the SDK. A hardcoded value
 *                cannot survive these — which is the point, since a hardcoded
 *                string is precisely how /.well-known/mcp came to advertise a
 *                version the SDK had already moved past.
 *   mpv14-mpv17  FAIL-CLOSED: we must never claim an era we cannot serve.
 *                Claiming too LOW is a missed connection; claiming too HIGH
 *                sends a modern client into a -32000 we advertised ourselves.
 *   mpv18-mpv27  All four discovery surfaces agree, and none of them still
 *                carries the dead $schema URL or a hardcoded version.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/mcp-protocol-version.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runMcpProtocolVersionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  return (async () => {
    // ── Hermetic-DB guard, BEFORE anything requires a route module ──────
    //
    // dental-seo and experiences-seo pull in db-factory, which falls back to
    // `/app/data/<vertical>.db` — the PRODUCTION path — when the env override
    // is unset, and initialises a schema there on first open. Measured: the
    // first run of this suite printed `opened at /app/data/dental.db` +
    // `schema initialized`, i.e. it wrote to a production path while every
    // assertion stayed green. That is the exact defect a reviewer found in
    // lokal#401; it is guarded here rather than rediscovered.
    //
    // The redirect must be set before the `require`, because db-factory reads
    // the env at open time and the route modules open on import.
    const dbEnvKeys = ["DENTAL_DB_PATH", "EXPERIENCES_DB_PATH"];
    const prevDbPaths = new Map(dbEnvKeys.map((k) => [k, process.env[k]]));
    const tmpDir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "mcp-proto-"));
    for (const k of dbEnvKeys) {
      process.env[k] = require("path").join(tmpDir, `${k.split("_")[0].toLowerCase()}.db`);
    }

    const mod = require("./mcp-protocol-version") as typeof import("./mcp-protocol-version");
    const sdk = require("@modelcontextprotocol/sdk/types.js") as {
      LATEST_PROTOCOL_VERSION: string;
      SUPPORTED_PROTOCOL_VERSIONS: string[];
    };

    // ═══════════════════════════════════════════════════════════════
    // mpv1-mpv6 — the era boundary.
    // ═══════════════════════════════════════════════════════════════
    assertEq(mod.eraOf("2026-07-28"), "modern", "mpv1: 2026-07-28 itself is the FIRST modern revision, not the last handshake one");
    assertEq(mod.eraOf("2025-11-25"), "handshake", "mpv2: the revision immediately before it is handshake");
    assertEq(mod.eraOf("2025-06-18"), "handshake", "mpv3: …as is everything older");
    assertEq(mod.eraOf("2024-10-07"), "handshake", "mpv4: …down to the oldest the SDK accepts");
    assertEq(mod.eraOf("2027-01-01"), "modern", "mpv5: a FUTURE revision is modern — the rule is a boundary, not a list, so a spec we have never heard of is classified correctly rather than silently treated as legacy");
    assertEq(mod.MCP_MODERN_ERA_FIRST_VERSION, "2026-07-28", "mpv6: the boundary is the revision that removed the handshake");

    // ═══════════════════════════════════════════════════════════════
    // mpv7-mpv13 — DERIVED, not written down.
    //
    // These compare against the SDK's own constants rather than literals. If
    // someone replaces the derivation with a hardcoded string that happens to
    // be right today, these still pass today and break the moment the SDK
    // moves — which is exactly when a stale hardcode does its damage, and
    // exactly when nothing else would notice.
    // ═══════════════════════════════════════════════════════════════
    const d = mod.mcpProtocolDeclaration();
    assertEq(d.protocolVersion, sdk.LATEST_PROTOCOL_VERSION,
      "mpv7: the advertised version IS the SDK's LATEST — not a literal that was true when it was typed");
    assertEq(d.supportedProtocolVersions.length, sdk.SUPPORTED_PROTOCOL_VERSIONS.length,
      "mpv8: the supported list is the SDK's, entire");
    assertTrue(d.supportedProtocolVersions.every((v, i) => v === sdk.SUPPORTED_PROTOCOL_VERSIONS[i]),
      "mpv8b: …in the SDK's own order");
    assertTrue(d.supportedProtocolVersions.includes(d.protocolVersion),
      "mpv9: the advertised version is one we actually accept — advertising a version outside the supported set would be a connection failure we caused");
    assertTrue(d.supportedProtocolVersions.includes("2025-06-18"),
      "mpv10: 2025-06-18 is still accepted, so the surfaces that used to advertise it are not now rejecting the clients they attracted");
    assertEq(d.era, mod.eraOf(sdk.LATEST_PROTOCOL_VERSION),
      "mpv11: the declared era is derived from the declared version, not asserted separately — two fields that can disagree eventually will");
    assertTrue(d.supportedProtocolVersions !== sdk.SUPPORTED_PROTOCOL_VERSIONS,
      "mpv12: the array is a COPY — handing out the SDK's own array lets a caller mutate what every later reader sees");
    {
      const a = mod.mcpProtocolDeclaration();
      const b = mod.mcpProtocolDeclaration();
      a.supportedProtocolVersions.push("tampered");
      assertTrue(!b.supportedProtocolVersions.includes("tampered"),
        "mpv13: …proven by mutating one declaration and reading another");
    }

    // ═══════════════════════════════════════════════════════════════
    // mpv14-mpv17 — FAIL-CLOSED on the era claim.
    //
    // The asymmetry matters. Under-claiming costs a connection that could have
    // worked. OVER-claiming — saying we speak 2026-07-28 when the SDK cannot —
    // routes a modern client into `-32000 Server not initialized`, an error we
    // advertised our way into. So `modernEraSupported` must be a measurement of
    // the SDK, never a statement of intent.
    // ═══════════════════════════════════════════════════════════════
    const sdkHasModern = sdk.SUPPORTED_PROTOCOL_VERSIONS.some((v) => v >= "2026-07-28");
    assertEq(d.modernEraSupported, sdkHasModern,
      "mpv14: modernEraSupported EQUALS whether the SDK supports a 2026-07-28+ version — the one fact that determines it");
    assertEq(d.modernEraSupported, false,
      "mpv15: …which is false on SDK 1.30.0 (dist/esm/types.js byte-identical to 1.29.0; the 07-27 release predates the spec going Current). If this fails, criterion 1 just became buildable — that is the signal, not a broken test");
    assertTrue(!d.modernEraSupported ? /does NOT yet support/.test(d.note) : /Supports the 2026-07-28 era/.test(d.note),
      "mpv16: the human-readable note AGREES with the flag — a card whose prose contradicts its field is worse than one with no prose");
    assertTrue(!d.modernEraSupported ? d.note.includes("Server not initialized") : true,
      "mpv17: …and names the exact error a modern client will get, so the reader does not have to discover it by hitting it");

    // ═══════════════════════════════════════════════════════════════
    // mpv18-mpv27 — every discovery surface, actually rendered.
    //
    // Asserted on the emitted JSON, not on the source. The whole defect class
    // here is a value that is right in one place and stale in another.
    // ═══════════════════════════════════════════════════════════════
    const renderCard = async (routerPath: string, url: string): Promise<any> => {
      const routes = require(routerPath) as any;
      const router = routes.default ?? routes;
      const req: any = {
        method: "GET", url, originalUrl: url, path: url, query: {}, body: {},
        headers: { host: "example.test" },
        get(n: string) { return this.headers[n.toLowerCase()]; },
      };
      let settle: () => void;
      const done = new Promise<void>((r) => { settle = r; });
      const res: any = {
        statusCode: 200, _body: undefined,
        header() { return this; },
        set() { return this; },
        status(c: number) { this.statusCode = c; return this; },
        json(b: any) { this._body = b; settle(); return this; },
        send(b: any) { this._body = b; settle(); return this; },
      };
      router.handle(req, res, () => settle());
      await done;
      return res._body;
    };

    const surfaces: Array<[string, string, string]> = [
      ["rfb", "../routes/agent-readiness", "/.well-known/mcp/server-card.json"],
      ["dental", "../routes/dental-seo", "/.well-known/mcp/server-card.json"],
      ["experiences", "../routes/experiences-seo", "/.well-known/mcp/server-card.json"],
    ];

    for (const [label, path, url] of surfaces) {
      let card: any;
      try {
        card = await renderCard(path, url);
      } catch (err: any) {
        assertTrue(false, `mpv18-${label}: the card route renders (${String(err?.message ?? err)})`);
        continue;
      }
      assertTrue(!!card, `mpv18-${label}: the ${label} server-card renders (guards every assertion below it)`);
      if (!card) continue;

      assertEq(card.protocolVersion, sdk.LATEST_PROTOCOL_VERSION,
        `mpv19-${label}: …and carries protocolVersion. It was ABSENT on all three live domains — an agent could not tell which era we speak without connecting and failing`);
      assertEq(card.modernEraSupported, sdkHasModern,
        `mpv20-${label}: …and states, honestly, whether the 2026-07-28 era is served`);
      assertTrue(Array.isArray(card.supportedProtocolVersions) && card.supportedProtocolVersions.length > 0,
        `mpv21-${label}: …and lists every version it accepts, so a client can pick rather than guess`);
      assertEq(card.$schema, undefined,
        `mpv22-${label}: the dead $schema URL is gone — it 404s, and a $schema pointing at a 404 makes "we validated" indistinguishable from "the fetch failed"`);
      assertTrue(typeof card.schemaVersion === "string" && card.schemaVersion.length > 0,
        `mpv23-${label}: …while schemaVersion still names the SEP revision this shape follows`);
    }

    // All three must agree with each other, not merely each with the SDK.
    {
      const cards = await Promise.all(surfaces.map(([, p, u]) => renderCard(p, u).catch(() => null)));
      const versions = cards.filter(Boolean).map((c: any) => c.protocolVersion);
      assertEq(versions.length, 3, "mpv24: all three cards rendered");
      assertEq(new Set(versions).size, 1,
        "mpv25: …and all three advertise the SAME version. Three surfaces maintained separately is how one of them goes stale unnoticed");
    }

    // /.well-known/mcp — the surface that carried the stale 2025-06-18.
    {
      const manifest = await renderCard("../routes/discovery", "/.well-known/mcp");
      assertTrue(!!manifest, "mpv26: the /.well-known/mcp manifest renders");
      assertEq(manifest?.mcp_version, sdk.LATEST_PROTOCOL_VERSION,
        "mpv27: …and advertises the CEILING. It published 2025-06-18 — the floor — while prod negotiated up to 2025-11-25");
      assertTrue(Array.isArray(manifest?.mcp_supported_versions) && manifest.mcp_supported_versions.includes("2025-06-18"),
        "mpv27b: …and the full range, so the clients the old string attracted are still explicitly welcome");
    }

    // The guard has to assert it actually TOOK, or deleting the redirect above
    // leaves every assertion green while the suite writes to production again.
    for (const k of dbEnvKeys) {
      assertTrue(
        typeof process.env[k] === "string" && process.env[k]!.startsWith(tmpDir),
        `mpv28: ${k} was redirected away from /app/data before any route module opened a database`,
      );
    }
    for (const [k, v] of prevDbPaths) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runMcpProtocolVersionTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
