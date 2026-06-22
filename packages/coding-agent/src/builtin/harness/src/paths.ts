// paths.ts — single source of truth for where the harness is installed.
//
// Defaults are derived from THIS module's own location (repo root = the parent of `src/`),
// so a fresh `git clone` works anywhere with ZERO configuration. Every path is still
// environment-overridable for advanced layouts (e.g. a split install).
//
//   HARNESS_HOME         -> repo root (overrides the import.meta.url derivation)
//   HARNESS_AGENTS_DIR     -> registry of specialist bundles   (default <root>/agents)
//   HARNESS_TEAMS_DIR      -> named team recipes               (default <root>/teams)
//   HARNESS_BLUEPRINTS_DIR -> code-defined DAG recipes          (default <root>/blueprints)
//   HARNESS_THEMES_DIR     -> canonical theme files            (default <root>/themes)
//
// Re-export shims (e.g. ~/.summon/agent/extensions/summon-spawn.ts) resolve to the REAL module
// URL under ESM, so REPO_ROOT stays correct no matter where the shim lives.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = process.env.HARNESS_HOME
	? resolve(process.env.HARNESS_HOME)
	: resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const AGENTS_DIR = process.env.HARNESS_AGENTS_DIR ?? join(REPO_ROOT, "agents");
export const TEAMS_DIR = process.env.HARNESS_TEAMS_DIR ?? join(REPO_ROOT, "teams");
export const BLUEPRINTS_DIR = process.env.HARNESS_BLUEPRINTS_DIR ?? join(REPO_ROOT, "blueprints");
export const THEMES_DIR = process.env.HARNESS_THEMES_DIR ?? join(REPO_ROOT, "themes");

// The CLI entry the harness self-spawns for sub-agents. Resolved from THIS module's location so it is
// PATH-INDEPENDENT — it never relies on a `summon`/`.cmd` shim being on PATH (which Node's spawn cannot
// exec on Windows without a shell). Built `dist/cli.js` in a real install; the `.ts` source under
// --experimental-strip-types in a dev tree.
function resolveCliEntry(): string {
	const here = dirname(fileURLToPath(import.meta.url)); // .../builtin/harness/src
	const distJs = resolve(here, "..", "..", "..", "cli.js"); // .../dist/cli.js
	return existsSync(distJs) ? distJs : resolve(here, "..", "..", "..", "cli.ts"); // dev fallback
}
const CLI_ENTRY = resolveCliEntry();

// Optional explicit override: a command/binary on PATH (advanced). Prefer the PATH-independent default.
export const AGENT_BIN = process.env.SUMMON_BIN ?? null;

// Cross-platform self-spawn command for a sub-agent. The default routes through the running Node binary
// (`process.execPath`, a real executable — no .cmd shim resolution needed) + the resolved CLI entry, so
// it works identically on Windows and POSIX. An explicit SUMMON_BIN override is spawned as-is.
export function agentSpawnCommand(): { cmd: string; prefix: string[] } {
	if (AGENT_BIN) return { cmd: AGENT_BIN, prefix: [] };
	const prefix = CLI_ENTRY.endsWith(".ts") ? ["--experimental-strip-types", CLI_ENTRY] : [CLI_ENTRY];
	return { cmd: process.execPath, prefix };
}

// Config/state home (matches the engine: SUMMON_CODING_AGENT_DIR, default ~/.summon).
export const CONFIG_HOME = process.env.SUMMON_CODING_AGENT_DIR ?? join(homedir(), ".summon");
// Where the harness writes the generated registry index (the orchestrator's machine-readable roster).
export const REGISTRY_INDEX = join(CONFIG_HOME, "harness", "registry-index.json");
// Fleet-level observability (#8): cross-run spawn ledger + the rendered digest.
export const FLEET_LEDGER = join(CONFIG_HOME, "harness", "fleet.jsonl");
export const FLEET_SUMMARY = join(CONFIG_HOME, "harness", "fleet-summary.md");
// Durable run sessions (the resumable/approvable spine): one append-only event log per run under
// <runId>/events.jsonl, so a crashed/paused run can be discovered + resumed (Phase 2/3).
export const RUNS_DIR = join(CONFIG_HOME, "harness", "runs");
