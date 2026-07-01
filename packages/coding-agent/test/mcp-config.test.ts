import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadMcpServers, loadMcpServersFromPath } from "../src/core/mcp/config.ts";

describe("loadMcpServersFromPath", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "summon-mcp-config-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("parses an mcpServers JSON config into specs", () => {
		const path = join(dir, "mcp.json");
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: {
					"crucible-research": {
						command: "/opt/crucible/mcp/run.sh",
						args: ["--flag"],
						env: { KEY: "value" },
						cwd: "/opt/crucible",
					},
				},
			}),
		);

		const specs = loadMcpServersFromPath(path);
		expect(specs).toEqual([
			{
				name: "crucible-research",
				command: "/opt/crucible/mcp/run.sh",
				args: ["--flag"],
				env: { KEY: "value" },
				cwd: "/opt/crucible",
			},
		]);
	});

	test("expands multiple servers in one config", () => {
		const path = join(dir, "multi.json");
		writeFileSync(path, JSON.stringify({ mcpServers: { a: { command: "cmd-a" }, b: { command: "cmd-b" } } }));
		const specs = loadMcpServersFromPath(path);
		expect(specs.map((s) => s.name)).toEqual(["a", "b"]);
		expect(specs.map((s) => s.command)).toEqual(["cmd-a", "cmd-b"]);
	});

	test("treats a non-JSON executable path as a bare server command", () => {
		const path = join(dir, "run.sh");
		writeFileSync(path, "#!/usr/bin/env bash\nexec python server.py\n");
		const specs = loadMcpServersFromPath(path);
		expect(specs).toEqual([{ name: "run.sh", command: path, args: [] }]);
	});

	test("throws a clear error for a missing path", () => {
		expect(() => loadMcpServersFromPath(join(dir, "nope.json"))).toThrow(/does not exist/);
	});

	test("throws when an mcpServers entry has no command", () => {
		const path = join(dir, "bad.json");
		writeFileSync(path, JSON.stringify({ mcpServers: { broken: { args: [] } } }));
		expect(() => loadMcpServersFromPath(path)).toThrow(/no "command"/);
	});

	test("loadMcpServers flattens multiple config paths in order", () => {
		const a = join(dir, "a.json");
		const b = join(dir, "b.sh");
		writeFileSync(a, JSON.stringify({ mcpServers: { one: { command: "one" } } }));
		writeFileSync(b, "#!/bin/sh\n");
		const specs = loadMcpServers([a, b]);
		expect(specs.map((s) => s.name)).toEqual(["one", "b.sh"]);
	});
});
