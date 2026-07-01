/**
 * Turn `--mcp-config` server specs into live tool definitions the agent runtime can register.
 *
 * For each server we spawn the process, run the `initialize` handshake, enumerate its tools, and
 * wrap each remote tool as a summon {@link ToolDefinition} whose `execute` proxies to the server's
 * `tools/call`. The resulting definitions are handed to `createAgentSession({ customTools })`, where
 * they flow through the SAME registry and `--tools` allowlist as built-in and extension tools — so a
 * scout restricted to `--tools x_search,web_search,...` only ever sees those read-only tools, never
 * bash/edit/write or any un-allowlisted MCP tool.
 *
 * MCP tool names are kept verbatim (no server prefix) so an allowlist of bare tool names matches.
 */

import type { TextContent } from "@summon/ai";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type McpCallToolResult, type McpServerSpec, McpStdioClient, type McpToolInfo } from "./client.ts";

export interface McpDiagnostic {
	type: "error" | "warning";
	message: string;
}

export interface LoadMcpToolsResult {
	/** Tool definitions to pass as `customTools`. */
	tools: ToolDefinition[];
	/** Live server connections — the caller MUST `close()` these when the session ends. */
	clients: McpStdioClient[];
	/** Load-time problems (surfaced to the user; an "error" fails the run fail-closed). */
	diagnostics: McpDiagnostic[];
}

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

/** Normalize an MCP `inputSchema` into a JSON-Schema object usable as tool `parameters`. */
function toParametersSchema(inputSchema: McpToolInfo["inputSchema"]): TSchema {
	if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
		// FastMCP and friends already emit a JSON-Schema object ({type:"object", properties, required}).
		// summon's tool-argument validator accepts plain JSON Schema (not only TypeBox), so pass it through.
		return inputSchema as unknown as TSchema;
	}
	return EMPTY_OBJECT_SCHEMA as unknown as TSchema;
}

/** Flatten an MCP tool-call result into the text/details the agent runtime expects. */
function toToolResult(result: McpCallToolResult): { content: TextContent[]; details: unknown } {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	const content: TextContent[] = [];
	for (const block of blocks) {
		if (block && block.type === "text" && typeof block.text === "string") {
			content.push({ type: "text", text: block.text });
		} else if (block) {
			// Non-text content (rare for these research tools) — serialize so nothing is silently dropped.
			content.push({ type: "text", text: JSON.stringify(block) });
		}
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "(no content returned)" });
	}
	return { content, details: result };
}

function firstLine(text: string | undefined): string {
	if (!text) return "";
	const line = text.split("\n", 1)[0]?.trim() ?? "";
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function defineMcpTool(client: McpStdioClient, info: McpToolInfo): ToolDefinition {
	const description = info.description ?? `MCP tool "${info.name}" from server "${client.name}".`;
	return {
		name: info.name,
		label: info.name,
		description,
		promptSnippet: firstLine(description) || info.name,
		parameters: toParametersSchema(info.inputSchema),
		// Throw on transport/RPC failure (the loop records an error tool result). A tool-level failure
		// the server reports gracefully (isError) is passed through as content so the model can react.
		execute: async (_toolCallId, params) => {
			const result = await client.callTool(info.name, (params ?? {}) as Record<string, unknown>);
			return toToolResult(result);
		},
	};
}

/**
 * Spawn each server, initialize, list its tools, and build proxying tool definitions.
 *
 * Never throws: per-server failures become `error` diagnostics (fail-closed at the call site) and any
 * clients spawned so far are returned so the caller can tear them down.
 */
export async function loadMcpTools(specs: McpServerSpec[]): Promise<LoadMcpToolsResult> {
	const tools: ToolDefinition[] = [];
	const clients: McpStdioClient[] = [];
	const diagnostics: McpDiagnostic[] = [];

	for (const spec of specs) {
		let client: McpStdioClient | undefined;
		try {
			client = new McpStdioClient(spec);
			clients.push(client);
			await client.start();
			const remoteTools = await client.listTools();
			if (remoteTools.length === 0) {
				diagnostics.push({ type: "warning", message: `MCP server "${spec.name}" exposed no tools` });
			}
			for (const info of remoteTools) {
				tools.push(defineMcpTool(client, info));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({ type: "error", message: `Failed to load MCP server "${spec.name}": ${message}` });
			client?.close();
		}
	}

	return { tools, clients, diagnostics };
}
