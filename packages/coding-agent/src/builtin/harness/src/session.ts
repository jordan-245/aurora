// Harness v2 — durable run session (the resumable/approvable spine).
//
// Anthropic's "Scaling Managed Agents" makes the session a DURABLE, append-only event log that lives
// OUTSIDE the context window: a crashed harness reboots with wake(sessionId) and resumes from the last
// event; the harness itself is "cattle". Today Summon's orchestration (runBlueprint / spawn_agents) is
// in-memory only — a crash mid fan-out loses the whole run, and there is no pause/resume seam for a
// human approval gate. This module is that spine.
//
// Design (mirrors fleet.ts / blueprint.ts house style):
//   • PURE + injectable — no Pi/subprocess/network deps → fully unit-testable offline.
//   • One append-only JSONL log per run (one event per line); seq is monotonic IN-PROCESS (a class owns
//     the counter, so concurrent fan-out appends never race on a read-before-write).
//   • State is DERIVED by replaying events (event-sourcing) — the log is the source of truth, not a
//     mutable snapshot, so resume after a crash is just "read log → derive state → continue".
//
// The blueprint scheduler (blueprint.ts) consumes this via two optional hooks: a `journal` callback
// (write durably as the DAG advances) and a `resume`/`approved` state (skip already-done nodes; release
// approved gates). No journal == today's behaviour, byte-for-byte.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// ── event taxonomy ────────────────────────────────────────────────────────────
export type RunEventType =
	| "run_started" // { kind: "blueprint"|"fanout"|"team", name?, goal? }
	| "node_started" // { node, agent?, kind? }
	| "node_done" // { node, status, artifact_path?, output_excerpt? }
	| "node_skipped" // { node, skipped_by: string[] }
	| "approval_requested" // { gate, summary, node? }
	| "approval_decided" // { gate, approved: boolean, by?, reason? }
	| "run_finished"; // { status: "done"|"failed"|"paused" }

export interface RunEvent {
	seq: number; // 1-based, monotonic within a run
	ts: number;
	type: RunEventType;
	[k: string]: unknown;
}

// ── append/read (the durable JSONL log) ───────────────────────────────────────
export function readEvents(path: string): RunEvent[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return []; // no log yet == fresh run
	}
	const out: RunEvent[] = [];
	for (const l of raw.split("\n")) {
		if (!l.trim()) continue;
		try {
			out.push(JSON.parse(l) as RunEvent);
		} catch {
			/* skip a torn final line (crash mid-write) — the rest of the log still replays */
		}
	}
	return out;
}

// A run session owns an in-process monotonic seq so concurrent appends (wide fan-out) never race on a
// read-before-write. `resume(path)` re-opens an existing log and continues its seq.
export class RunSession {
	readonly path: string;
	private seq: number;
	private _events: RunEvent[];

	private constructor(path: string, seq: number, events: RunEvent[]) {
		this.path = path;
		this.seq = seq;
		this._events = events;
	}

	/** Start a fresh run (does not write until the first append). */
	static create(path: string): RunSession {
		mkdirSync(dirname(path), { recursive: true });
		return new RunSession(path, 0, []);
	}

	/** Re-open an existing run log and continue from its last event (the wake(sessionId) path). */
	static resume(path: string): RunSession {
		const events = readEvents(path);
		const maxSeq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
		return new RunSession(path, maxSeq, events);
	}

	append(type: RunEventType, fields: Record<string, unknown> = {}): RunEvent {
		const ev: RunEvent = { seq: ++this.seq, ts: Date.now(), type, ...fields };
		try {
			appendFileSync(this.path, `${JSON.stringify(ev)}\n`);
		} catch {
			/* best-effort durability: a write failure must never crash the live run */
		}
		this._events.push(ev);
		return ev;
	}

	events(): RunEvent[] {
		return this._events.slice();
	}
}

// ── derived state (pure event-sourcing reducer) ───────────────────────────────
export type NodeOutcome = "done" | "failed" | "skipped";
export type ApprovalState = "none" | "pending" | "approved" | "denied";

export interface DerivedState {
	runStatus: "running" | "done" | "failed" | "paused";
	nodes: Map<string, NodeOutcome>; // terminal node outcomes seen in the log
	outputs: Map<string, string>; // node_done output excerpts (for downstream templating on resume)
	approvals: Map<string, ApprovalState>; // gate -> latest decision
}

export function deriveState(events: RunEvent[]): DerivedState {
	const nodes = new Map<string, NodeOutcome>();
	const outputs = new Map<string, string>();
	const approvals = new Map<string, ApprovalState>();
	let runStatus: DerivedState["runStatus"] = "running";
	for (const e of events) {
		switch (e.type) {
			case "node_done": {
				const id = String(e.node);
				nodes.set(id, (e.status as NodeOutcome) ?? "done");
				if (typeof e.output_excerpt === "string") outputs.set(id, e.output_excerpt);
				break;
			}
			case "node_skipped":
				nodes.set(String(e.node), "skipped");
				break;
			case "approval_requested":
				if (!approvals.has(String(e.gate))) approvals.set(String(e.gate), "pending");
				break;
			case "approval_decided":
				approvals.set(String(e.gate), e.approved ? "approved" : "denied");
				break;
			case "run_finished":
				runStatus = (e.status as DerivedState["runStatus"]) ?? "done";
				break;
		}
	}
	return { runStatus, nodes, outputs, approvals };
}

// Blueprint-shaped resume view: which nodes are already terminal+done (skip re-running), their outputs
// (for {{node.<id>}} templating), and which approval gates have been granted/denied.
export interface BlueprintResume {
	done: Set<string>; // nodes that completed `done` (re-running would duplicate side effects)
	failedOrSkipped: Set<string>; // nodes already failed/skipped (stay terminal on resume)
	output: Map<string, string>;
	approved: Set<string>; // approval gates granted
	denied: Set<string>; // approval gates explicitly denied
}

export function blueprintResume(events: RunEvent[]): BlueprintResume {
	const s = deriveState(events);
	const done = new Set<string>();
	const failedOrSkipped = new Set<string>();
	for (const [id, outcome] of s.nodes) {
		if (outcome === "done") done.add(id);
		else failedOrSkipped.add(id);
	}
	const approved = new Set<string>();
	const denied = new Set<string>();
	for (const [gate, st] of s.approvals) {
		if (st === "approved") approved.add(gate);
		else if (st === "denied") denied.add(gate);
	}
	return { done, failedOrSkipped, output: s.outputs, approved, denied };
}

// Convenience for a human-facing surface (TUI/web): the gates currently awaiting a decision.
export function pendingApprovals(events: RunEvent[]): { gate: string; summary?: string; node?: string }[] {
	const decided = new Set<string>();
	const requested = new Map<string, { summary?: string; node?: string }>();
	for (const e of events) {
		if (e.type === "approval_decided") decided.add(String(e.gate));
		else if (e.type === "approval_requested")
			requested.set(String(e.gate), { summary: e.summary as string, node: e.node as string });
	}
	return [...requested.entries()].filter(([g]) => !decided.has(g)).map(([gate, v]) => ({ gate, ...v }));
}
