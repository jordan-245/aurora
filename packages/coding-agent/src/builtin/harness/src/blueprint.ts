// Harness v2 — blueprints: a code-defined DAG that interleaves deterministic CODE nodes and scoped
// AGENT nodes. The harness owns the graph + the code nodes; the LLM runs only inside contained agent
// nodes — Stripe's "blueprint" primitive ("putting LLMs into contained boxes compounds into
// system-wide reliability"). Generalises teams: arbitrary depends_on edges (not just linear stages),
// fail-CLOSED dependent skipping, and per-node output passing. Zero Pi/subprocess deps → unit-testable;
// the extension injects runAgent/runCode.
//
// A node is EXACTLY one kind:
//   agent node — { agent, prompt }      → spawn a specialist with the (templated) metaprompt
//   code  node — { run }                → the HARNESS runs a deterministic shell command itself
// Downstream prompts/commands may reference an upstream node's output via {{node.<id>}} (only for a
// declared dependency — fillTemplate fail-closes otherwise, so you can only read what you depend on).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentBundle, fillTemplate, isDestructiveCmd, resolveProject } from "./core.ts";
import { BLUEPRINTS_DIR } from "./paths.ts";

export interface BlueprintNode {
	id: string;
	depends_on?: string[];
	// agent node:
	agent?: string;
	prompt?: string;
	verify?: string; // optional deterministic acceptance check for an agent node
	// code node:
	run?: string;
	// human-in-the-loop: a node so flagged will not launch until its approval gate is granted; the run
	// PAUSES (durably) at that boundary and resumes once the gate is decided (see runBlueprint opts).
	requires_approval?: boolean;
}
export interface Blueprint {
	name: string;
	description?: string;
	nodes: BlueprintNode[];
	_dir?: string;
}

export type NodeKind = "agent" | "code";
export function nodeKind(n: BlueprintNode): NodeKind {
	return n.run !== undefined ? "code" : "agent";
}

// What an injected executor returns for one node. `output` is exposed downstream as {{node.<id>}}.
export interface NodeRun {
	ok: boolean;
	output: string;
	result?: unknown;
}
export interface BlueprintExec {
	runAgent(agent: string, prompt: string, node: BlueprintNode): Promise<NodeRun>;
	runCode(cmd: string, node: BlueprintNode): Promise<NodeRun>;
}

export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped" | "awaiting_approval";
export interface BlueprintNodeResult {
	id: string;
	kind: NodeKind;
	status: NodeStatus;
	agent?: string;
	prompt?: string; // the TEMPLATED prompt actually sent (agent nodes)
	run?: string; // the TEMPLATED command actually run (code nodes)
	output: string;
	result?: unknown;
	skipped_by?: string[]; // dep ids that failed/were skipped (for skipped nodes)
}
export interface BlueprintOutcome {
	name: string;
	nodes: BlueprintNodeResult[];
	// paused == the run hit a human-approval gate (or had unmet, already-granted-elsewhere gates) and
	// stopped at a durable boundary. Resume by re-invoking runBlueprint with the journal's approvals.
	paused?: boolean;
	awaiting?: string[]; // node ids parked on an approval gate this run
}

// Durable/approval hooks for runBlueprint. ALL OPTIONAL — omitting `opts` is byte-for-byte the old
// in-memory behaviour. `journal` is called as the DAG advances (write to a RunSession); `resume` seeds
// already-completed nodes (skip re-running side effects); `isApproved` releases a node's approval gate.
export interface BlueprintRunOpts {
	journal?: (ev: { type: string; [k: string]: unknown }) => void;
	resume?: { done?: Set<string>; failedOrSkipped?: Set<string>; output?: Map<string, string> };
	isApproved?: (node: BlueprintNode) => boolean;
}

// ── validator (fail-closed at load, sentinel-style) ───────────────────────────
export function validateBlueprint(bp: Blueprint, registry: Map<string, AgentBundle>): void {
	const err = (m: string) => {
		throw new Error(`blueprint '${bp?.name ?? "?"}': ${m}`);
	};
	if (!bp.name || !Array.isArray(bp.nodes) || bp.nodes.length === 0) err("missing name/nodes");
	const ids = new Set<string>();
	for (const n of bp.nodes) {
		if (!n || typeof n.id !== "string" || !n.id) err("a node is missing its id");
		if (ids.has(n.id)) err(`duplicate node id '${n.id}'`);
		ids.add(n.id);
		const isCode = n.run !== undefined;
		const isAgent = n.agent !== undefined || n.prompt !== undefined;
		if (isCode && isAgent)
			err(`node '${n.id}': a node is EITHER a code node (run) OR an agent node (agent+prompt), not both`);
		if (!isCode && !isAgent) err(`node '${n.id}': must be a code node (run) or an agent node (agent+prompt)`);
		if (isCode) {
			if (typeof n.run !== "string" || !n.run.trim())
				err(`node '${n.id}': code node 'run' must be a non-empty string`);
			if (isDestructiveCmd(n.run!)) err(`node '${n.id}': code node 'run' is a blocked destructive command`);
		} else {
			if (typeof n.agent !== "string" || typeof n.prompt !== "string")
				err(`node '${n.id}': agent node needs both 'agent' and 'prompt' strings`);
			if (!registry.has(n.agent!)) err(`node '${n.id}': unknown agent '${n.agent}'`);
			if (registry.get(n.agent!)?.may_spawn)
				err(
					`node '${n.id}': agent '${n.agent}' is a delegation agent (may_spawn) — blueprints orchestrate workers, not other orchestrators`,
				);
		}
	}
	// edges exist + no self-dependency
	for (const n of bp.nodes) {
		for (const d of n.depends_on ?? []) {
			if (d === n.id) err(`node '${n.id}': depends on itself`);
			if (!ids.has(d)) err(`node '${n.id}': depends_on unknown node '${d}'`);
		}
	}
	assertAcyclic(bp, err);
}

// Kahn's algorithm — reject any cycle (would deadlock the scheduler).
function assertAcyclic(bp: Blueprint, err: (m: string) => never): void {
	const indeg = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const n of bp.nodes) indeg.set(n.id, 0);
	for (const n of bp.nodes) {
		for (const d of n.depends_on ?? []) {
			indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
			(dependents.get(d) ?? dependents.set(d, []).get(d)!).push(n.id);
		}
	}
	const queue = [...indeg.entries()].filter(([, c]) => c === 0).map(([id]) => id);
	let seen = 0;
	while (queue.length) {
		const id = queue.shift()!;
		seen++;
		for (const dep of dependents.get(id) ?? []) {
			indeg.set(dep, (indeg.get(dep) ?? 0) - 1);
			if (indeg.get(dep) === 0) queue.push(dep);
		}
	}
	if (seen !== bp.nodes.length) err("dependency cycle detected");
}

// ── loader (global + project-local .summon/blueprints), validated fail-closed ─────
export function loadBlueprints(registry: Map<string, AgentBundle>, cwd = process.cwd()): Map<string, Blueprint> {
	const { root } = resolveProject(cwd);
	const globalDir = process.env.HARNESS_BLUEPRINTS_DIR ?? BLUEPRINTS_DIR;
	const out = new Map<string, Blueprint>();
	for (const dir of [globalDir, join(root, ".summon/blueprints")]) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const bp = JSON.parse(readFileSync(join(dir, f), "utf8")) as Blueprint;
			bp._dir = dir;
			validateBlueprint(bp, registry); // fail-closed
			out.set(bp.name, bp);
		}
	}
	return out;
}

// ── runner — continuous DAG scheduler (max parallelism) ───────────────────────
// A node launches the instant all its deps are `done`; any number run concurrently. If a dep
// `failed`/`skipped`, the dependent is `skipped` (fail-closed — never run downstream on broken
// upstream). Returns node results in declaration order.
export async function runBlueprint(
	bp: Blueprint,
	vars: Record<string, string>,
	exec: BlueprintExec,
	opts: BlueprintRunOpts = {},
): Promise<BlueprintOutcome> {
	const status = new Map<string, NodeStatus>(bp.nodes.map((n) => [n.id, "pending"]));
	const output = new Map<string, string>();
	const results = new Map<string, BlueprintNodeResult>();
	const running = new Set<Promise<void>>();
	const journal = opts.journal ?? (() => {});
	const awaiting = new Set<string>();

	// RESUME: seed already-terminal nodes from the durable log so we never re-run a completed node's
	// side effects. Done nodes carry their recorded output forward for {{node.<id>}} templating.
	if (opts.resume) {
		for (const id of opts.resume.done ?? []) {
			if (!status.has(id)) continue;
			status.set(id, "done");
			const out = opts.resume.output?.get(id) ?? "";
			output.set(id, out);
			const n = bp.nodes.find((x) => x.id === id)!;
			results.set(id, { id, kind: nodeKind(n), status: "done", agent: n.agent, run: n.run, output: out });
		}
		for (const id of opts.resume.failedOrSkipped ?? []) {
			if (!status.has(id) || status.get(id) === "done") continue;
			status.set(id, "failed");
			const n = bp.nodes.find((x) => x.id === id)!;
			results.set(id, { id, kind: nodeKind(n), status: "failed", agent: n.agent, run: n.run, output: "" });
		}
	}

	// Propagate skips transitively: a pending node whose any dep failed/was skipped is itself skipped.
	const propagateSkips = (): void => {
		let changed = true;
		while (changed) {
			changed = false;
			for (const n of bp.nodes) {
				if (status.get(n.id) !== "pending") continue;
				const blocked = (n.depends_on ?? []).filter((d) => {
					const s = status.get(d);
					return s === "failed" || s === "skipped";
				});
				if (blocked.length) {
					status.set(n.id, "skipped");
					results.set(n.id, {
						id: n.id,
						kind: nodeKind(n),
						status: "skipped",
						agent: n.agent,
						run: n.run,
						output: "",
						skipped_by: blocked,
					});
					changed = true;
				}
			}
		}
	};

	const launch = (n: BlueprintNode): void => {
		status.set(n.id, "running");
		const v: Record<string, string> = { ...vars };
		for (const d of n.depends_on ?? []) v[`node.${d}`] = output.get(d) ?? "";
		const kind = nodeKind(n);
		const filled = fillTemplate(kind === "code" ? n.run! : n.prompt!, v);
		journal({ type: "node_started", node: n.id, kind, agent: n.agent });
		const p = (async () => {
			let run: NodeRun;
			try {
				run = kind === "code" ? await exec.runCode(filled, n) : await exec.runAgent(n.agent!, filled, n);
			} catch (e) {
				run = { ok: false, output: e instanceof Error ? e.message : String(e) };
			}
			status.set(n.id, run.ok ? "done" : "failed");
			output.set(n.id, run.output ?? "");
			results.set(n.id, {
				id: n.id,
				kind,
				status: run.ok ? "done" : "failed",
				agent: n.agent,
				prompt: kind === "agent" ? filled : undefined,
				run: kind === "code" ? filled : undefined,
				output: run.output ?? "",
				result: run.result,
			});
			journal({
				type: "node_done",
				node: n.id,
				status: run.ok ? "done" : "failed",
				output_excerpt: (run.output ?? "").slice(0, 1500),
			});
		})();
		running.add(p);
		void p.finally(() => running.delete(p));
	};

	// A ready node gated by approval that has NOT been granted parks in `awaiting` (durable pause point)
	// instead of launching. The gate id is the node id (one gate per gated node).
	const gatedHeld = (n: BlueprintNode): boolean => {
		if (!n.requires_approval) return false;
		if (opts.isApproved?.(n)) return false; // gate granted (from the durable journal) → release
		if (!awaiting.has(n.id)) {
			awaiting.add(n.id);
			status.set(n.id, "awaiting_approval");
			results.set(n.id, {
				id: n.id,
				kind: nodeKind(n),
				status: "awaiting_approval",
				agent: n.agent,
				run: n.run,
				output: "",
			});
			journal({
				type: "approval_requested",
				gate: n.id,
				node: n.id,
				summary: (n.prompt ?? n.run ?? "").slice(0, 200),
			});
		}
		return true;
	};

	for (;;) {
		propagateSkips();
		const ready = bp.nodes.filter(
			(n) => status.get(n.id) === "pending" && (n.depends_on ?? []).every((d) => status.get(d) === "done"),
		);
		const launchable = ready.filter((n) => !gatedHeld(n));
		for (const n of launchable) launch(n);
		if (running.size === 0) {
			propagateSkips();
			// terminal == nothing pending AND nothing parked on an approval gate.
			if (!bp.nodes.some((n) => status.get(n.id) === "pending") && awaiting.size === 0) break;
			break; // no work in flight: either all terminal, or PAUSED on approval gate(s)
		}
		await Promise.race(running);
	}

	const paused = awaiting.size > 0;
	if (paused) journal({ type: "run_finished", status: "paused" });
	return { name: bp.name, nodes: bp.nodes.map((n) => results.get(n.id)!), paused, awaiting: [...awaiting] };
}
