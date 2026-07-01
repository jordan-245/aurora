/**
 * Minimal MCP (Model Context Protocol) stdio client.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over a child process's stdin/stdout — the MCP stdio
 * transport (each message is a single UTF-8 line of JSON; no Content-Length framing). This is a
 * deliberately small, dependency-free client: it implements exactly the three methods summon needs
 * to expose a server's tools to the model — `initialize`, `tools/list`, and `tools/call` — plus the
 * `notifications/initialized` handshake. It does NOT implement the full protocol (no sampling,
 * resources, prompts, or server→client requests); unrecognized inbound messages are ignored.
 *
 * The official @modelcontextprotocol/sdk is intentionally not used: it is not a dependency of this
 * monorepo, and the surface we need is tiny. The framing mirrors the proven RpcWorker pattern
 * already in the harness (spawn with piped stdio, StringDecoder over stdout, id-correlated replies).
 */

import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { spawnProcess } from "../../utils/child-process.ts";

/** One MCP server to launch (stdio transport). */
export interface McpServerSpec {
	/** Logical name (from the config key, or the config file basename for a bare command). */
	name: string;
	/** Executable to run. */
	command: string;
	/** Arguments passed to the executable. */
	args?: string[];
	/** Extra environment variables merged over the current process env. */
	env?: Record<string, string>;
	/** Working directory for the server process. */
	cwd?: string;
}

/** A tool advertised by an MCP server via `tools/list`. */
export interface McpToolInfo {
	name: string;
	description?: string;
	/** JSON Schema describing the tool's arguments (MCP `inputSchema`). */
	inputSchema?: Record<string, unknown>;
}

/** A content block returned by `tools/call`. */
export interface McpContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

/** Result of an MCP `tools/call`. */
export interface McpCallToolResult {
	content?: McpContentBlock[];
	isError?: boolean;
	[key: string]: unknown;
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	method: string;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
	method?: string;
}

/** Protocol version we advertise on `initialize`. Servers negotiate down/across as needed. */
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;
/** Keep only the tail of stderr so a chatty server can't grow memory unbounded. */
const MAX_STDERR_TAIL = 8_000;

export interface McpStdioClientOptions {
	/** Timeout for a single `tools/call` / `tools/list` request. Default 60s. */
	requestTimeoutMs?: number;
	/** Timeout for the `initialize` handshake. Default 30s. */
	initTimeoutMs?: number;
}

/**
 * A live connection to one MCP server process.
 *
 * Lifecycle: `new McpStdioClient(spec)` spawns the process; `await start()` performs the
 * `initialize` handshake; `listTools()` / `callTool()` issue requests; `close()` tears it down.
 */
export class McpStdioClient {
	readonly name: string;
	private readonly proc: ChildProcess;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly decoder = new StringDecoder("utf8");
	private stdoutBuffer = "";
	private stderrTail = "";
	private closed = false;
	private exitInfo: string | undefined;
	private readonly requestTimeoutMs: number;
	private readonly initTimeoutMs: number;

	constructor(spec: McpServerSpec, options: McpStdioClientOptions = {}) {
		this.name = spec.name;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;

		this.proc = spawnProcess(spec.command, spec.args ?? [], {
			stdio: ["pipe", "pipe", "pipe"],
			env: spec.env ? { ...process.env, ...spec.env } : process.env,
			cwd: spec.cwd,
		});

		this.proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
		this.proc.stderr?.on("data", (chunk: Buffer) => this.onStderr(chunk));
		this.proc.on("error", (error: Error) => this.onExit(`spawn error: ${error.message}`));
		this.proc.on("exit", (code, signal) =>
			this.onExit(`server exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})`),
		);
	}

	/** Perform the MCP `initialize` handshake. Rejects if the server never answers. */
	async start(): Promise<void> {
		await this.request(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "summon", version: "1.0.0" },
			},
			this.initTimeoutMs,
		);
		// Notifications carry no id and expect no reply.
		this.notify("notifications/initialized", {});
	}

	/** List every tool the server advertises, following `nextCursor` pagination to completion. */
	async listTools(): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const result = (await this.request("tools/list", cursor ? { cursor } : {})) as {
				tools?: McpToolInfo[];
				nextCursor?: string;
			};
			if (Array.isArray(result?.tools)) {
				tools.push(...result.tools);
			}
			cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
		} while (cursor);
		return tools;
	}

	/** Invoke a tool. Rejects on a JSON-RPC error; a tool-level failure comes back as `isError`. */
	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
		return (await this.request("tools/call", { name, arguments: args })) as McpCallToolResult;
	}

	/** Terminate the server process and reject any in-flight requests. Idempotent. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.failPending(new Error(`MCP server "${this.name}" connection closed`));
		try {
			this.proc.stdin?.end();
		} catch {
			// ignore
		}
		try {
			this.proc.kill();
		} catch {
			// ignore
		}
	}

	private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		if (this.closed || this.exitInfo) {
			return Promise.reject(new Error(`MCP server "${this.name}" is not running: ${this.exitInfo ?? "closed"}`));
		}
		const id = this.nextId++;
		const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						`MCP request "${method}" to "${this.name}" timed out after ${timeoutMs ?? this.requestTimeoutMs}ms`,
					),
				);
			}, timeoutMs ?? this.requestTimeoutMs);
			this.pending.set(id, { resolve, reject, timer, method });
			const stdin = this.proc.stdin;
			if (!stdin || !stdin.writable) {
				this.settle(id, undefined, new Error(`MCP server "${this.name}" stdin is not writable`));
				return;
			}
			stdin.write(line, (error) => {
				if (error) this.settle(id, undefined, new Error(`MCP write to "${this.name}" failed: ${error.message}`));
			});
		});
	}

	private notify(method: string, params: unknown): void {
		if (this.closed) return;
		const stdin = this.proc.stdin;
		if (!stdin || !stdin.writable) return;
		stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private onStdout(chunk: Buffer): void {
		this.stdoutBuffer += this.decoder.write(chunk);
		let newlineIndex = this.stdoutBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line) this.handleLine(line);
			newlineIndex = this.stdoutBuffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let message: JsonRpcResponse;
		try {
			message = JSON.parse(line) as JsonRpcResponse;
		} catch {
			// Non-JSON stdout (e.g. a stray server log) is not our concern — ignore it.
			return;
		}
		// We only correlate responses to our requests; ignore server-originated notifications/requests.
		if (message.id === undefined || message.id === null) return;
		if (typeof message.id !== "number") return;
		if (message.error) {
			this.settle(
				message.id,
				undefined,
				new Error(message.error.message || `MCP error code ${message.error.code ?? "?"}`),
			);
			return;
		}
		this.settle(message.id, message.result, undefined);
	}

	private settle(id: number, result: unknown, error: Error | undefined): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (error) pending.reject(error);
		else pending.resolve(result);
	}

	private onStderr(chunk: Buffer): void {
		this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_TAIL);
	}

	private onExit(reason: string): void {
		if (this.exitInfo) return;
		const tail = this.stderrTail.trim();
		this.exitInfo = tail ? `${reason}: ${tail}` : reason;
		this.failPending(new Error(`MCP server "${this.name}" ${this.exitInfo}`));
	}

	private failPending(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
