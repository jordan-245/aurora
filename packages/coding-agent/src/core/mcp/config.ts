/**
 * Loading of `--mcp-config <path>` into concrete {@link McpServerSpec} launch specs.
 *
 * Two accepted shapes, auto-detected by content (so crucible can point at either):
 *
 *  1. A JSON config file (the Claude Code / MCP convention):
 *       { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...}, "cwd": "..." } } }
 *     Every entry becomes one server. This is the portable, documented format.
 *
 *  2. A directly executable server command. If the file does not parse as an `mcpServers` JSON
 *     object, the path itself is treated as the server executable (e.g. crucible's `mcp/run.sh`)
 *     and launched with no arguments.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { McpServerSpec } from "./client.ts";

interface McpServerConfigEntry {
	command?: string;
	args?: unknown;
	env?: unknown;
	cwd?: unknown;
}

function toStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map((v) => String(v));
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = String(v);
	}
	return out;
}

/**
 * Resolve one `--mcp-config` path into its server spec(s).
 *
 * @throws Error if the path is missing, or a JSON `mcpServers` map contains an entry with no command.
 */
export function loadMcpServersFromPath(path: string): McpServerSpec[] {
	if (!existsSync(path)) {
		throw new Error(`--mcp-config path does not exist: ${path}`);
	}

	const raw = readFileSync(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}

	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const servers = (parsed as { mcpServers?: unknown }).mcpServers;
		if (servers && typeof servers === "object" && !Array.isArray(servers)) {
			const specs: McpServerSpec[] = [];
			for (const [name, entryValue] of Object.entries(servers as Record<string, unknown>)) {
				const entry = (entryValue ?? {}) as McpServerConfigEntry;
				const command = typeof entry.command === "string" ? entry.command : undefined;
				if (!command) {
					throw new Error(`--mcp-config server "${name}" in ${path} has no "command"`);
				}
				specs.push({
					name,
					command,
					args: toStringArray(entry.args),
					env: toStringRecord(entry.env),
					cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
				});
			}
			return specs;
		}
	}

	// Not an mcpServers JSON object → treat the path itself as an executable server command.
	return [{ name: basename(path), command: path, args: [] }];
}

/** Resolve all `--mcp-config` paths, in order, into a flat list of server specs. */
export function loadMcpServers(paths: string[]): McpServerSpec[] {
	return paths.flatMap((path) => loadMcpServersFromPath(path));
}
