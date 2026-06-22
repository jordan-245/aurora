// RpcWorker — a PooledWorker backed by a long-lived `summon --mode rpc` subprocess.
// Implements the PooledWorker contract so WarmPool can manage it.
// JSONL framing: split on \n only, strip trailing \r — never use node readline.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { type AgentBundle, assertSpawnAuth, buildSystemPrompt, buildWorkerArgs, spawnEnv } from "./core.ts";
import { agentSpawnCommand } from "./paths.ts";
import type { PooledWorker } from "./pool.ts";

export interface RpcRunResult {
	text: string;
	ok: boolean; // false on timeout, process death, or prompt rejection
}

export class RpcWorker implements PooledWorker {
	readonly id: string;
	private proc: ReturnType<typeof spawn>;
	private alive = true;
	private reqId = 0;
	// Pending id-correlated responses from the summon RPC server
	private pendingResponses = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void }>();
	// Live event listeners (added/removed by run() lifecycle)
	private eventHandlers: Array<(ev: any) => void> = [];

	private constructor(id: string, proc: ReturnType<typeof spawn>) {
		this.id = id;
		this.proc = proc;
	}

	// ── Factory ──────────────────────────────────────────────────────────────
	static async start(bundle: AgentBundle, opts: { root?: string; protected?: string[] } = {}): Promise<RpcWorker> {
		const sys = buildSystemPrompt(bundle);

		// Shared with the one-shot transport: applies the model, system prompt, tool
		// allowlist, WORKER_SEAL_FLAGS (no extension/skill/prompt/theme/context
		// discovery), the explicit skill, and the write-guard. Sealing keeps a pooled
		// worker fast (no jiti init / fs walks) and isolated (no ambient project
		// context leaking into a reused, tool-restricted sub-agent).
		const args = buildWorkerArgs(bundle, ["--mode", "rpc", "--no-session"]);

		const env = spawnEnv(opts.root, opts.protected);
		assertSpawnAuth(env, sys); // fail-closed auth check before we spawn the rpc worker

		const { cmd, prefix } = agentSpawnCommand();
		const proc = spawn(cmd, [...prefix, ...args], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const worker = new RpcWorker(id, proc);

		// Pipe stderr for debugging; don't let it buffer-block
		proc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

		// Attach the JSONL reader before anything else so we catch all output
		worker._attachReader();

		// Track process death (sets alive=false + rejects pending)
		proc.once("exit", (code, signal) => {
			worker.alive = false;
			worker._rejectAll(new Error(`rpc process exited code=${code} signal=${signal}`));
		});
		proc.once("error", (err: Error) => {
			worker.alive = false;
			worker._rejectAll(err);
		});
		proc.stdin?.once("error", (err: Error) => {
			worker.alive = false;
			worker._rejectAll(err);
		});

		return worker;
	}

	// ── JSONL reader (LF-only framing, no readline) ───────────────────────────
	private _attachReader(): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";

		this.proc.stdout!.on("data", (chunk: Buffer | string) => {
			buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
			while (true) {
				const nl = buffer.indexOf("\n");
				if (nl === -1) break;
				let line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1); // strip optional \r
				if (!line.trim()) continue;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				this._dispatch(ev);
			}
		});

		this.proc.stdout!.on("end", () => {
			// Flush any partial line left in the buffer
			const remaining = (buffer + decoder.end()).trim();
			if (remaining) {
				const line = remaining.endsWith("\r") ? remaining.slice(0, -1) : remaining;
				try {
					this._dispatch(JSON.parse(line));
				} catch {
					/* ignore */
				}
			}
			buffer = "";
		});
	}

	// Route a parsed event: id-correlated responses go to pending resolvers; everything
	// else is broadcast to event handlers (run() lifecycle listeners).
	private _dispatch(ev: any): void {
		// id-correlated response (prompt accepted, new_session done, etc.)
		if (ev.type === "response" && ev.id && this.pendingResponses.has(ev.id)) {
			const p = this.pendingResponses.get(ev.id)!;
			this.pendingResponses.delete(ev.id);
			p.resolve(ev);
			return;
		}
		// Agent events (agent_start, message_end, agent_end, ...) — broadcast to listeners.
		// Iterate over a snapshot so that an off() call inside a handler is safe.
		for (const h of [...this.eventHandlers]) {
			try {
				h(ev);
			} catch {
				/* ignore — defensive */
			}
		}
	}

	private _rejectAll(err: Error): void {
		for (const p of this.pendingResponses.values()) p.reject(err);
		this.pendingResponses.clear();
	}

	// Register an event listener; returns an unsubscribe function.
	private _onEvent(handler: (ev: any) => void): () => void {
		this.eventHandlers.push(handler);
		return () => {
			const i = this.eventHandlers.indexOf(handler);
			if (i !== -1) this.eventHandlers.splice(i, 1);
		};
	}

	// ── send helper ───────────────────────────────────────────────────────────
	// Send a JSON-RPC command (unique id appended), await the id-correlated response.
	// 30-second command-level timeout (separate from the run-level timeout).
	private send(cmd: object): Promise<any> {
		if (!this.alive) return Promise.reject(new Error("RpcWorker: process not alive"));
		const stdin = this.proc.stdin;
		if (!stdin || !stdin.writable) return Promise.reject(new Error("RpcWorker: stdin not writable"));
		const id = `r_${++this.reqId}`;
		const line = `${JSON.stringify({ ...cmd, id })}\n`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingResponses.delete(id);
				reject(new Error(`RpcWorker: command timeout — ${JSON.stringify(cmd)}`));
			}, 30_000);
			this.pendingResponses.set(id, {
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			try {
				stdin.write(line);
			} catch (e: any) {
				this.pendingResponses.delete(id);
				clearTimeout(timer);
				reject(e);
			}
		});
	}

	// ── PooledWorker API ─────────────────────────────────────────────────────

	/**
	 * Send a prompt; accumulate assistant text from message_end events (same logic
	 * as spawnOnce — last assistant message_end text wins across multi-turn runs);
	 * resolve when agent_end arrives. Timeout → ok:false.
	 */
	async run(prompt: string, timeoutMs = 600_000): Promise<RpcRunResult> {
		if (!this.healthy()) return { text: "", ok: false };
		let lastText = "";

		return new Promise<RpcRunResult>((resolve) => {
			let done = false;
			const finish = (r: RpcRunResult) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				off();
				this.proc.removeListener("exit", onDie);
				this.proc.removeListener("error", onDie);
				resolve(r);
			};

			const timer = setTimeout(() => finish({ text: lastText, ok: false }), timeoutMs);

			// Accumulate assistant text + detect completion
			const off = this._onEvent((ev) => {
				// Final answer = LAST assistant message_end text (matching spawnOnce convention)
				if (ev.type === "message_end" && ev.message?.role === "assistant" && Array.isArray(ev.message.content)) {
					const t = ev.message.content
						.filter((c: any) => c?.type === "text")
						.map((c: any) => c.text as string)
						.join("");
					if (t) lastText = t;
				}
				if (ev.type === "agent_end") finish({ text: lastText, ok: true });
			});

			// Process death while in-flight → abort
			const onDie = () => finish({ text: lastText, ok: false });
			this.proc.once("exit", onDie);
			this.proc.once("error", onDie);

			// Send the prompt; handle rejection or failure immediately
			this.send({ type: "prompt", message: prompt })
				.then((resp: any) => {
					if (!resp?.success) finish({ text: "", ok: false });
				})
				.catch(() => finish({ text: "", ok: false }));
		});
	}

	/**
	 * Send new_session and await its response — wipes context so the next task
	 * starts fresh. Called by WarmPool.release() between tasks.
	 */
	async reset(): Promise<void> {
		await this.send({ type: "new_session" });
	}

	/** Process alive, stdin writable, no hard error. */
	healthy(): boolean {
		return this.alive && !!this.proc.stdin?.writable;
	}

	/** Terminate the summon process (SIGTERM → SIGKILL after 1s). */
	destroy(): void {
		this.alive = false;
		try {
			this.proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		// Escalate if the process ignores SIGTERM
		const t = setTimeout(() => {
			if (!this.proc.killed)
				try {
					this.proc.kill("SIGKILL");
				} catch {
					/* ignore */
				}
		}, 1000);
		// Don't let the timer keep Node alive if everything else is done
		if (typeof t === "object" && t !== null && "unref" in t) (t as NodeJS.Timeout).unref();
	}
}
