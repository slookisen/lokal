// ─── Vertical Config — Phase 4.1 ────────────────────────────────
//
// Domene-spesifikke verdier (entity-navn, agent-schedules, batch-størrelser,
// connector-adresser) leses fra YAML-filer under `verticals/<id>/config.yaml`.
//
// Workers tilkalles via `getConfig(verticalId)` og henter typesikker
// konfig — ingen hardkodet "produsent"/"lokalmat" i services etter Phase 4.4.
//
// Cold-load: konfig leses ved boot (`loadConfigsAtBoot()`), valideres med
// Zod, fryses med deepFreeze og caches. Endringer krever redeploy.
//
// "Fail fast" — malformed YAML eller manglende felt = app refuses to boot.
// Det er bedre enn å starte opp i en udefinert tilstand som verifier-en
// senere må gjette på.
//
// Se ARCHITECTURE.md §3.4 og PHASE4-PLAN.md §2 for design-rasjonale.

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { z } from "zod";

// ─── Schema ─────────────────────────────────────────────────────

/**
 * Konfig pr agent. Schedule er informasjonelt pr Phase 4.1 — Cowork
 * scheduled-tasks eier faktisk dispatching. `batch_size` og `cap_per_run`
 * er aktive (services leser dem fra Phase 4.2 og utover).
 */
const AgentConfigSchema = z.object({
  enabled: z.boolean(),
  schedule: z.string().optional(),
  batch_size: z.number().int().positive().optional(),
  cap_per_run: z.number().int().positive().optional(),
});

const VerticalConfigSchema = z.object({
  vertical_id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/,
    "vertical_id må være lowercase, starte med bokstav, kun [a-z0-9_-]"),
  display_name: z.string().min(1),
  domain: z.string().min(1),
  domain_dictionary: z.object({
    entity: z.string().min(1),
    entity_plural: z.string().min(1),
    entity_plural_long: z.string().min(1),
    service: z.string().min(1),
    buyer: z.string().min(1),
  }),
  agents: z.record(z.string(), AgentConfigSchema),
  connectors: z.object({
    github_repo: z.string().min(1),
    fly_app: z.string().min(1),
    resend_domain: z.string().min(1),
  }),
});

export type VerticalConfig = z.infer<typeof VerticalConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ─── Internals ──────────────────────────────────────────────────

/**
 * Deep-freeze så services ikke kan mutere config ved uhell — selv om
 * en bug skulle gjøre `cfg.agents.marketing.batch_size = 1`, vil node
 * kaste i strict-mode istedenfor å silently drift state.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

let cache: Map<string, VerticalConfig> | null = null;

// ─── Public API ─────────────────────────────────────────────────

/**
 * Les og valider alle vertical-config-filer fra disk. Kall denne ved
 * app-boot, FØR noen service prøver å lese config.
 *
 * Throws hvis:
 * - VERTICAL_CONFIG_DIR ikke eksisterer
 * - en config.yaml er malformed
 * - en config feiler Zod-validering
 * - mappenavn != vertical_id-felt
 * - default vertical 'rfb' mangler (når ikke i test-mode)
 */
export function loadConfigsAtBoot(opts?: {
  dir?: string;
  requireRfb?: boolean;
}): void {
  const dir = opts?.dir
    ?? process.env.VERTICAL_CONFIG_DIR
    ?? path.resolve(process.cwd(), "verticals");
  const requireRfb = opts?.requireRfb ?? true;

  if (!fs.existsSync(dir)) {
    throw new Error(`Vertical config dir not found: ${dir}`);
  }

  const verticals = fs
    .readdirSync(dir)
    .filter((d) => fs.statSync(path.join(dir, d)).isDirectory());

  const map = new Map<string, VerticalConfig>();
  for (const vid of verticals) {
    const file = path.join(dir, vid, "config.yaml");
    if (!fs.existsSync(file)) continue;

    let raw: unknown;
    try {
      // JSON_SCHEMA disables YAML 1.1 booleans like NO/YES that bite Norwegian
      // strings. "Norway problem": `country: NO` would parse as `false` under
      // default schema. JSON_SCHEMA treats NO/YES/ON/OFF as plain strings.
      raw = yaml.load(fs.readFileSync(file, "utf-8"), {
        schema: yaml.JSON_SCHEMA,
        filename: file,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to parse ${file}: ${msg}`);
    }

    let parsed: VerticalConfig;
    try {
      parsed = VerticalConfigSchema.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Schema validation failed for ${file}: ${msg}`);
    }

    if (parsed.vertical_id !== vid) {
      throw new Error(
        `Directory name '${vid}' does not match vertical_id '${parsed.vertical_id}' in ${file}`,
      );
    }

    map.set(parsed.vertical_id, deepFreeze(parsed));
  }

  if (requireRfb && !map.has("rfb")) {
    throw new Error(
      `Required vertical 'rfb' not found in ${dir}. Add verticals/rfb/config.yaml.`,
    );
  }

  cache = map;
}

/**
 * Hent typesikker config for en vertikal. Default 'rfb' for backwards-
 * kompatibilitet — nye call-sites bør sende eksplisitt verticalId fra
 * request-context (Phase 4.6 setter opp dette via middleware).
 */
export function getConfig(verticalId: string = "rfb"): VerticalConfig {
  if (!cache) {
    throw new Error(
      "loadConfigsAtBoot() must be called before getConfig(). Check src/index.ts boot order.",
    );
  }
  const cfg = cache.get(verticalId);
  if (!cfg) {
    const known = Array.from(cache.keys()).join(", ");
    throw new Error(`Unknown vertical: '${verticalId}' (known: ${known})`);
  }
  return cfg;
}

/**
 * Liste ID-er for alle innlastede vertikaler. Brukes av admin-endepunkter
 * og verifier for å iterere på tvers av tenants.
 */
export function listVerticals(): string[] {
  if (!cache) {
    throw new Error("loadConfigsAtBoot() must be called before listVerticals()");
  }
  return Array.from(cache.keys());
}

/**
 * Map en HTTP Host-header til en vertical_id.
 *
 * Phase 4.1: returnerer ALLTID 'rfb' (bare RFB lever på rettfrabonden.com).
 * Phase 4.6: bygger ut subdomain/alias-mapping fra config.connectors eller
 * et separat config.aliases-felt. Helperen er på plass nå så middleware-
 * laget ikke må refaktoreres når vi får vertikal nr. 2.
 *
 * @param hostname f.eks. 'rettfrabonden.com', 'tannlege.rettfrabonden.com'
 */
export function lookupVerticalByHost(_hostname: string | undefined): string {
  // PHASE 4.1 placeholder. Se PHASE4-PLAN.md §3.3.
  return "rfb";
}

/**
 * KUN for tester — nullstill cache mellom test-cases.
 */
export function _resetConfigCacheForTests(): void {
  cache = null;
}
