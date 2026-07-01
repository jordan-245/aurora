import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { loadMcpTools } from "../src/core/mcp/load.ts";

// A minimal, correct MCP stdio server (newline-delimited JSON-RPC 2.0) used to exercise the real
// client end-to-end: initialize handshake, tools/list, and tools/call.
const FAKE_SERVER = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
    } else if (msg.method === "notifications/initialized") {
      // notification: no reply
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "Echoes the input value.", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
        { name: "boom", description: "Reports a graceful tool error.", inputSchema: { type: "object", properties: {} } }
      ] } });
    } else if (msg.method === "tools/call") {
      const args = (msg.params && msg.params.arguments) || {};
      if (msg.params && msg.params.name === "echo") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + args.value }], isError: false } });
      } else if (msg.params && msg.params.name === "boom") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "graceful failure" }], isError: true } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } });
      }
    }
  }
});
`;

// A server that exits immediately without answering — the connection must fail loudly.
const DEAD_SERVER = `process.exit(0);`;

describe("loadMcpTools (MCP stdio client integration)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "summon-mcp-client-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("discovers tools and proxies a successful tools/call to assistant text", async () => {
		const script = join(dir, "server.mjs");
		writeFileSync(script, FAKE_SERVER);

		const { tools, clients, diagnostics } = await loadMcpTools([
			{ name: "fake", command: process.execPath, args: [script] },
		]);
		try {
			expect(diagnostics).toEqual([]);
			expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);

			const echo = tools.find((t) => t.name === "echo");
			expect(echo).toBeDefined();
			// The MCP inputSchema is carried through as the tool's parameters (plain JSON Schema).
			expect((echo?.parameters as { required?: string[] }).required).toEqual(["value"]);

			const result = await echo?.execute(
				"call-1",
				{ value: "hi" },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			);
			expect(result?.content).toEqual([{ type: "text", text: "echo:hi" }]);
		} finally {
			for (const client of clients) client.close();
		}
	});

	test("passes a graceful tool-level error through as content (does not throw)", async () => {
		const script = join(dir, "server.mjs");
		writeFileSync(script, FAKE_SERVER);

		const { tools, clients } = await loadMcpTools([{ name: "fake", command: process.execPath, args: [script] }]);
		try {
			const boom = tools.find((t) => t.name === "boom");
			const result = await boom?.execute(
				"call-2",
				{},
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			);
			expect(result?.content).toEqual([{ type: "text", text: "graceful failure" }]);
		} finally {
			for (const client of clients) client.close();
		}
	});

	test("reports a fail-closed error diagnostic when a server never initializes", async () => {
		const script = join(dir, "dead.mjs");
		writeFileSync(script, DEAD_SERVER);

		const { tools, clients, diagnostics } = await loadMcpTools([
			{ name: "dead", command: process.execPath, args: [script] },
		]);
		try {
			expect(tools).toEqual([]);
			expect(diagnostics.some((d) => d.type === "error")).toBe(true);
		} finally {
			for (const client of clients) client.close();
		}
	});
});
