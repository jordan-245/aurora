import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@summon/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// MCP tools are registered as `customTools`. This test proves the safety boundary the scout relies on:
// with `--tools` naming only research tools, the un-named sibling MCP tool AND every built-in
// (bash/write/edit/read) are excluded from the registry — the model can never reach a mutating tool.
function mcpStyleTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `Read-only research tool ${name}`,
		promptSnippet: `${name} does research`,
		parameters: {
			type: "object",
			properties: { query: { type: "string" } },
		} as unknown as ToolDefinition["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

describe("MCP custom tools honor the --tools allowlist", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `summon-mcp-allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("activates only the allowlisted MCP tool and excludes siblings + all built-ins", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			// Two MCP tools exposed by the server, but the scout only allowlists one.
			customTools: [mcpStyleTool("web_search"), mcpStyleTool("x_balance")],
			tools: ["web_search"],
		});

		const allNames = session.getAllTools().map((t) => t.name);
		const activeNames = session.getActiveToolNames();

		// The allowlisted MCP tool is present and active.
		expect(allNames).toContain("web_search");
		expect(activeNames).toContain("web_search");

		// The un-allowlisted sibling MCP tool is excluded entirely.
		expect(allNames).not.toContain("x_balance");
		expect(activeNames).not.toContain("x_balance");

		// No built-in — especially no mutating/exec tool — leaks into the registry.
		for (const builtin of ["bash", "write", "edit", "read", "grep", "find", "ls"]) {
			expect(allNames).not.toContain(builtin);
			expect(activeNames).not.toContain(builtin);
		}

		session.dispose();
	});
});
