// Harness v2 — Pi extension: registers `spawn_agent` (one task) and `spawn_agents` (parallel fan-out)
// so an orchestrator summon session can delegate to specialised sub-agents. Project-aware (GLOBAL +
// <project>/.summon/agents, .harness.json protected paths). Wraps src/core.ts (single-sourced).

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../index.ts";
import { type Blueprint, type BlueprintExec, loadBlueprints, type NodeRun, runBlueprint } from "../src/blueprint.ts";
import { cacheKey, isCacheable, ResultCache } from "../src/cache.ts";
import {
	buildSystemPrompt,
	estimateTokens,
	isDestructiveCmd,
	loadRegistries,
	registryDigest,
	runWithReview,
	spawnAgent,
	WindowGovernor,
	writeRegistryIndex,
} from "../src/core.ts";
import { aggregateFleet, appendFleetEntry, auditPrompt, fleetDigest, readFleet } from "../src/fleet.ts";
import { FLEET_LEDGER, FLEET_SUMMARY, REGISTRY_INDEX } from "../src/paths.ts";
import { drainAllPools, isPrewarmed, pickTransport, prewarm, spawnViaPool } from "../src/pool-transport.ts";
import { loadTeams, runTeam } from "../src/teams.ts";

export default function harness(summon: ExtensionAPI) {
	const { reg: registry, maxWeight, protectedList, root } = loadRegistries(process.cwd()); // fail-closed validation at load
	// Window-aware governor: weighted concurrency cap + Claude-Max rolling-window token tracking.
	// HARNESS_WINDOW_TOKENS>0 turns on a hard window gate; 0 (default) tracks + surfaces only (no hang).
	const gov = new WindowGovernor({ maxWeight, budgetTokens: Number(process.env.HARNESS_WINDOW_TOKENS ?? 0) });
	const names = [...registry.keys()].filter((n) => n !== "orchestrator").join(", ");
	// AUTHORITATIVE registry awareness: a compact roster injected into every spawn tool description so the
	// orchestrator always knows each specialist's tier/tools/contract (never depends on reading a file).
	const digest = registryDigest(registry, { exclude: ["orchestrator"] });
	// Within-run result cache + in-flight dedup (#5): identical READ-ONLY sub-tasks collapse to one
	// execution. Disabled with HARNESS_NO_CACHE=1. Write-capable agents are never cached (safety in cache.ts).
	const cache = process.env.HARNESS_NO_CACHE ? null : new ResultCache();
	// Boot-time prompt audit (#8 skill-bloat): render each worker's system prompt once and flag any that
	// exceed the byte threshold — context that costs tokens every spawn without earning it.
	const bootAudits = [...registry.values()].map((b) => auditPrompt(b.name, buildSystemPrompt(b)));
	summon.events?.emit?.("agent-event", {
		id: "boot",
		agent: "harness",
		ts: Date.now(),
		t: "boot-audit",
		audits: bootAudits,
		bloated: bootAudits.filter((a) => a.over).map((a) => a.name),
	});
	// One place that records a finished spawn: rolling-window tokens + the cross-run fleet ledger (#8).
	const logSpawn = (b: { name: string; model_tier: string }, r: any, spentTokens: number): void => {
		gov.record(spentTokens);
		try {
			appendFleetEntry(FLEET_LEDGER, {
				ts: Date.now(),
				agent: b.name,
				model: r.meta?.model ?? "",
				status: r.status,
				elapsed_s: r.meta?.elapsed_s ?? 0,
				bytes: r.meta?.bytes ?? 0,
				est_tokens: spentTokens,
				cached: r.cached ?? null,
				verify: r.verify?.passed ?? null,
			});
		} catch {
			/* best-effort */
		}
	};
	// Best-effort machine-readable index for humans/tooling (the digest is the source of truth at runtime).
	let indexPath = REGISTRY_INDEX;
	try {
		indexPath = writeRegistryIndex(registry, REGISTRY_INDEX).path;
	} catch {
		/* read-only install: the tool-description digest still carries the roster */
	}
	// Opt-in pre-warm (HARNESS_PREWARM=scout,builder): stand up idle rpc workers so first spawns are
	// instant. Fire-and-forget so it never blocks startup; drained on shutdown.
	const prewarmNames = (process.env.HARNESS_PREWARM ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((n) => n && n !== "orchestrator" && registry.has(n));
	if (prewarmNames.length) {
		const bundles = prewarmNames.map((n) => registry.get(n)!);
		void prewarm(bundles, { root, protected: protectedList })
			.then((summary) =>
				summon.events?.emit?.("agent-event", {
					id: "prewarm",
					agent: "harness",
					ts: Date.now(),
					t: "prewarm",
					summary,
				}),
			)
			.catch(() => {});
	}
	const runDir = (ctx: any) => join(tmpdir(), "harness-runs", ctx?.sessionId ?? "session");

	async function runOne(
		agent: string,
		prompt: string,
		task_id: string,
		ctx: any,
		verify?: string,
		transport?: "oneshot" | "pool",
	): Promise<any> {
		const b = registry.get(agent);
		if (!b) return { agent, status: "failed", error: `no such agent '${agent}'. have: ${names}` };
		const emit = (e: any) => summon.events?.emit?.("agent-event", { id: task_id, agent, ts: Date.now(), ...e });
		// Resolve transport: explicit wins; otherwise a pre-warmed bundle uses its hot pool, else oneshot.
		const t = transport ?? (isPrewarmed(agent) ? "pool" : "oneshot");
		const cacheable = !!cache && isCacheable(b);
		const key = cacheable ? cacheKey(b, prompt, verify) : "";
		// Fast path: a stored cache hit returns instantly — no governor slot, no spawn, zero token spend.
		if (cacheable) {
			const hit = cache!.peek(key);
			if (hit) {
				emit({ t: "done", status: hit.status, verify: hit.verify?.passed, cached: "cache" });
				logSpawn(b, hit, 0);
				return hit;
			}
		}
		const release = await gov.admit(b);
		emit({ t: "spawned", model: b.model_tier, window_pct: gov.windowPct(), load_pct: gov.loadPct() }); // -> the observability dashboard
		try {
			const exec = () =>
				t === "pool"
					? spawnViaPool(b, prompt, {
							runDir: runDir(ctx),
							taskId: task_id,
							verify,
							protected: protectedList,
							root,
						})
					: spawnAgent(b, prompt, {
							runDir: runDir(ctx),
							taskId: task_id,
							verify,
							protected: protectedList,
							root,
							onEvent: (ev) => {
								if (ev?.type === "tool_execution_start") emit({ t: "tool", tool: ev.toolName, phase: "start" });
								else if (ev?.type === "tool_execution_end") emit({ t: "tool", phase: "end" });
							},
						});
			let r: any;
			let source = "miss";
			if (cacheable) {
				const out = await cache!.run(key, exec);
				r = out.result;
				source = out.source;
			} else {
				r = await exec();
			}
			// Only a real execution (a cache MISS) spends window tokens; hits/dedups cost nothing.
			const spent = source === "miss" ? estimateTokens(prompt.length + (r.meta?.bytes ?? 0)) : 0;
			logSpawn(b, r, spent);
			emit({ t: "done", status: r.status, verify: r.verify?.passed, window_pct: gov.windowPct(), cached: r.cached });
			return r;
		} catch (err) {
			emit({ t: "done", status: "failed" });
			throw err;
		} finally {
			release();
		}
	}
	const fmt = (r: any) =>
		r.error
			? `[${r.agent} → failed] ${r.error}`
			: `[${r.agent} → ${r.status} · contract ${r.contract.passed ? "PASS" : `FAIL:${r.contract.missing.join(",")}`}` +
				`${r.verify ? ` · verify ${r.verify.passed ? "PASS" : "FAIL"}` : ""} · ${r.meta.model} ${r.meta.elapsed_s.toFixed(0)}s]` +
				`${r.verify && !r.verify.passed ? `\nverify output: ${r.verify.output.slice(-300)}` : ""}\n\n${r.artifact_excerpt}`;

	// Build a structured reviewer metaprompt embedding the original task, builder summary, and diff.
	function reviewerPrompt(task: string, summary: string, diff: string): string {
		return [
			'ROLE: You are a code reviewer (the "reviewer" specialist) verifying a builder\'s work.',
			"",
			"TASK: Verify that the git diff below correctly implements the task, introduces no regressions, and meets all acceptance criteria.",
			"",
			"## Original task",
			task,
			"",
			"## Builder change-summary",
			summary,
			"",
			"## Git diff",
			"```diff",
			diff.slice(0, 12000),
			"```",
			"",
			"ACCEPTANCE: End your reply with exactly:",
			"## verdict",
			"APPROVE or REJECT with a one-line reason.",
			"## claims",
			"List each claim you verified.",
			"## could-not-verify",
			"List anything you could not check from the diff alone.",
		].join("\n");
	}

	summon.registerTool({
		name: "spawn_agent",
		label: "Spawn specialised sub-agent",
		description: `Delegate ONE task to a specialised sub-agent; returns its result + output-contract verdict. You write the metaprompt (ROLE/TASK/SCOPE/INPUTS/TOOLS/ACCEPTANCE/TERMINAL/DO-NOT).\nRegistry (name[tier; tools; ->contract]): ${digest}\nFull index: ${indexPath}`,
		parameters: Type.Object({
			agent: Type.String({ description: `one of: ${names}` }),
			prompt: Type.String({ description: "the metaprompt for the sub-agent" }),
			task_id: Type.Optional(Type.String()),
			verify: Type.Optional(
				Type.String({
					description:
						"a shell ACCEPTANCE command the HARNESS runs itself (deterministic; overrides the agent's claim). e.g. 'pytest tests/test_x.py'",
				}),
			),
			review: Type.Optional(
				Type.Boolean({
					description:
						"after a write-capable build completes 'done', auto-run the reviewer over the git diff; result fails unless the reviewer APPROVEs",
				}),
			),
			transport: Type.Optional(
				Type.Union([Type.Literal("oneshot"), Type.Literal("pool")], {
					description:
						"execution transport: 'oneshot' (default, cold summon -p) or 'pool' (warm summon --mode rpc worker, reused across tasks)",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const task_id = p.task_id ?? p.agent;
			const transport: "oneshot" | "pool" | undefined = p.transport;
			const bundle = registry.get(p.agent);
			const isWriteCapable = bundle
				? bundle.tools.some((t: string) => ["write", "edit", "bash"].includes(t))
				: false;
			const reviewerBundle = registry.get("reviewer");

			if (p.review && isWriteCapable && reviewerBundle) {
				const outcome = await runWithReview(
					() => runOne(p.agent, p.prompt, task_id, ctx, p.verify, transport),
					async (b) => {
						let diff = "";
						try {
							diff = execSync(`git -C ${JSON.stringify(root)} diff`, {
								encoding: "utf8",
								maxBuffer: 10 * 1024 * 1024,
							});
						} catch {
							diff = "";
						}
						const rp = reviewerPrompt(p.prompt, b.artifact_excerpt, diff);
						return runOne("reviewer", rp, `${task_id}-review`, ctx);
					},
				);
				const verdict = outcome.approved ? "APPROVED" : `REJECTED — ${outcome.reason}`;
				const text =
					fmt(outcome.build) +
					"\n\n=== REVIEW: " +
					verdict +
					" ===\n\n" +
					(outcome.review ? fmt(outcome.review) : "");
				return { content: [{ type: "text", text }], details: outcome, isError: !outcome.approved };
			}

			// Default path — transport threaded; oneshot behaviour byte-for-byte unchanged
			const r = await runOne(p.agent, p.prompt, task_id, ctx, p.verify, transport);
			return { content: [{ type: "text", text: fmt(r) }], details: r, isError: r.status === "failed" };
		},
	});

	summon.registerTool({
		name: "run_team",
		label: "Run a named team (sequential stages, parallel steps)",
		description: `Run a named team recipe — stages run sequentially, steps within a stage run in parallel. Available teams are loaded from global + project-local .summon/teams/ directories.`,
		parameters: Type.Object({
			team: Type.String({ description: 'name of the team to run (e.g. "build-review")' }),
			vars: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "template variables to fill {{placeholders}} in step prompts",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const teams = loadTeams(registry, process.cwd());
			const team = teams.get(p.team);
			if (!team) {
				const available = [...teams.keys()].join(", ") || "(none loaded)";
				return {
					content: [{ type: "text", text: `team '${p.team}' not found. available: ${available}` }],
					isError: true,
					details: undefined,
				};
			}
			try {
				const outcome = await runTeam(team, p.vars ?? {}, (agent, prompt) =>
					runOne(agent, prompt, `${p.team}:${agent}`, ctx),
				);
				const text = outcome.stages
					.map((stage, i) => {
						const stepTexts = stage.map((step) => fmt(step.result)).join("\n\n---\n\n");
						return `=== Stage ${i + 1} ===\n\n${stepTexts}`;
					})
					.join("\n\n");
				return { content: [{ type: "text", text }], details: outcome };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `run_team failed: ${msg}` }], isError: true, details: undefined };
			}
		},
	});

	// Deterministic CODE-node executor: the HARNESS runs the shell command itself (the agent never
	// touches it). Validated non-destructive at load; re-guarded here at run time (defence in depth).
	function runCodeNode(cmd: string): NodeRun {
		if (isDestructiveCmd(cmd)) return { ok: false, output: "blocked: destructive command" };
		try {
			const out = execSync(cmd, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 180000 });
			return { ok: true, output: out.slice(-2000) };
		} catch (e: unknown) {
			const ex = e as { stdout?: string; stderr?: string; message?: string };
			return {
				ok: false,
				output: ((ex.stdout ?? "") + (ex.stderr ?? "") || ex.message || "command failed").slice(-2000),
			};
		}
	}

	summon.registerTool({
		name: "run_blueprint",
		label: "Run a code-defined DAG (deterministic code + scoped agent nodes)",
		description:
			"Run a named blueprint: a DAG of CODE nodes (the harness runs shell deterministically) and AGENT nodes " +
			"(scoped specialists). Nodes run as soon as their depends_on are done (wide parallelism); a failed node " +
			"fail-closes its dependents. Upstream output is available downstream via {{node.<id>}}.",
		parameters: Type.Object({
			blueprint: Type.String({ description: "name of the blueprint to run" }),
			vars: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "template variables to fill {{placeholders}} in node prompts/commands",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const blueprints = loadBlueprints(registry, process.cwd());
			const bp: Blueprint | undefined = blueprints.get(p.blueprint);
			if (!bp) {
				const available = [...blueprints.keys()].join(", ") || "(none loaded)";
				return {
					content: [{ type: "text", text: `blueprint '${p.blueprint}' not found. available: ${available}` }],
					isError: true,
					details: undefined,
				};
			}
			const exec: BlueprintExec = {
				runAgent: async (agent, prompt, node) => {
					const r = await runOne(agent, prompt, node.id, ctx, node.verify);
					return { ok: r.status === "done", output: r.artifact_excerpt ?? "", result: r };
				},
				runCode: async (cmd) => runCodeNode(cmd),
			};
			try {
				const outcome = await runBlueprint(bp, p.vars ?? {}, exec);
				const text = outcome.nodes
					.map((n) => {
						const head = `=== ${n.id} [${n.kind}${n.agent ? `:${n.agent}` : ""}] -> ${n.status} ===`;
						if (n.status === "skipped")
							return `${head}\nskipped (upstream not done: ${(n.skipped_by ?? []).join(", ")})`;
						return `${head}\n${n.output.slice(0, 1200)}`;
					})
					.join("\n\n");
				const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
				return { content: [{ type: "text", text }], details: outcome, isError: failed };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `run_blueprint failed: ${msg}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	summon.registerTool({
		name: "spawn_agents",
		label: "Spawn sub-agents in parallel",
		description: `Run MULTIPLE specialised sub-agents CONCURRENTLY (wide fan-out) — use for independent tasks. Independent tasks run concurrently; a pre-warmed agent always uses its hot pool, and same-agent batches of ≥8 auto-use the warm worker pool (≈30-47% faster), else cold one-shot. Override with transport.\nRegistry: ${digest}`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					agent: Type.String(),
					prompt: Type.String(),
					task_id: Type.Optional(Type.String()),
					verify: Type.Optional(Type.String({ description: "shell ACCEPTANCE command the harness runs itself" })),
				}),
				{ description: "independent tasks to run at once" },
			),
			transport: Type.Optional(
				Type.Union([Type.Literal("oneshot"), Type.Literal("pool")], {
					description:
						"force a transport for the whole batch; default is adaptive (pool only for ≥8 same-agent tasks)",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const counts = new Map<string, number>();
			for (const t of p.tasks) counts.set(t.agent, (counts.get(t.agent) ?? 0) + 1);
			const results = await Promise.all(
				p.tasks.map((t: any, i: number) =>
					runOne(
						t.agent,
						t.prompt,
						t.task_id ?? `${t.agent}-${i}`,
						ctx,
						t.verify,
						pickTransport(counts.get(t.agent) ?? 0, p.transport, isPrewarmed(t.agent)),
					),
				),
			);
			return { content: [{ type: "text", text: results.map(fmt).join("\n\n---\n\n") }], details: { results } };
		},
	});

	// On shutdown: drain warm pools (no orphaned rpc procs) and write the cross-run fleet digest (#8).
	summon.on?.("session_shutdown", async () => {
		await drainAllPools();
		try {
			writeFileSync(FLEET_SUMMARY, fleetDigest(aggregateFleet(readFleet(FLEET_LEDGER))));
		} catch {
			/* best-effort */
		}
	});
}
