// Harness v2 — Pi extension: registers `spawn_agent` (one task) and `spawn_agents` (parallel fan-out)
// so an orchestrator summon session can delegate to specialised sub-agents. Project-aware (GLOBAL +
// <project>/.summon/agents, .harness.json protected paths). Wraps src/core.ts (single-sourced).

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../index.ts";
import {
	type Blueprint,
	type BlueprintExec,
	type BlueprintNode,
	type BlueprintOutcome,
	loadBlueprints,
	type NodeRun,
	runBlueprint,
} from "../src/blueprint.ts";
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
import { FLEET_LEDGER, FLEET_SUMMARY, REGISTRY_INDEX, RUNS_DIR } from "../src/paths.ts";
import { drainAllPools, isPrewarmed, pickTransport, prewarm, spawnViaPool } from "../src/pool-transport.ts";
import { blueprintResume, listResumableRuns, makeRunId, runEventsPath, runMeta } from "../src/runstore.ts";
import { deriveState, RunSession, readEvents } from "../src/session.ts";
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
	// Durable run sessions (Phase 2/3): journal every blueprint/team/fan-out run to an append-only log so
	// a crashed or human-paused run is discoverable + resumable. HARNESS_DURABLE=0 opts out (journaling off).
	const DURABLE = process.env.HARNESS_DURABLE !== "0";
	// Crash recovery: at boot, surface any run that didn't finish (crashed) or is paused on an approval gate.
	if (DURABLE) {
		try {
			const resumable = listResumableRuns(RUNS_DIR);
			if (resumable.length)
				summon.events?.emit?.("agent-event", {
					id: "boot",
					agent: "harness",
					ts: Date.now(),
					t: "resumable-runs",
					runs: resumable.map((r) => ({
						runId: r.runId,
						kind: r.kind,
						name: r.name,
						status: r.status,
						awaiting: r.awaiting.length,
					})),
				});
		} catch {
			/* best-effort discovery */
		}
	}
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

	// Start a durable run session (or null when DURABLE is off). The run_started event is self-describing
	// (kind/name/vars/tasks) so resume needs nothing but the log. Returns the session + its run id.
	function startRun(
		kind: "blueprint" | "team" | "fanout" | "spawn",
		name: string,
		meta: Record<string, unknown>,
		ctx: any,
	): { session: RunSession | null; runId: string | null } {
		if (!DURABLE) return { session: null, runId: null };
		try {
			const runId = makeRunId(kind, name, ctx?.sessionId ?? "session");
			const session = RunSession.create(runEventsPath(RUNS_DIR, runId));
			session.append("run_started", { kind, name, ...meta });
			return { session, runId };
		} catch {
			return { session: null, runId: null }; // durability is best-effort; never block a run
		}
	}
	const journalOf = (session: RunSession | null) =>
		session ? (e: { type: string; [k: string]: unknown }) => session.append(e.type as never, e) : undefined;

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
				// Durable session: journal each step so a crashed team run is discoverable + resumable.
				const { session, runId } = startRun("team", p.team, { vars: p.vars ?? {} }, ctx);
				const outcome = await runTeam(
					team,
					p.vars ?? {},
					(agent, prompt) => runOne(agent, prompt, `${p.team}:${agent}`, ctx),
					{ journal: journalOf(session) },
				);
				if (session) session.append("run_finished", { status: "done" });
				const text = runId ? `${renderTeam(outcome)}\n\n(durable run: ${runId})` : renderTeam(outcome);
				return { content: [{ type: "text", text }], details: { ...outcome, runId } };
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

	// ── durable run helpers (Phase 2/3): journal + resume + approval. The pure DAG/team logic lives in
	//    blueprint.ts/teams.ts (unit-tested); these are the thin wiring shared by run_blueprint /
	//    resume_run / approve_gate. ──
	function blueprintExec(ctx: any): BlueprintExec {
		return {
			runAgent: async (agent, prompt, node) => {
				const r = await runOne(agent, prompt, node.id, ctx, node.verify);
				return { ok: r.status === "done", output: r.artifact_excerpt ?? "", result: r };
			},
			runCode: async (cmd) => runCodeNode(cmd),
		};
	}

	async function executeBlueprint(
		bp: Blueprint,
		vars: Record<string, string>,
		ctx: any,
		session: RunSession | null,
		resume?: ReturnType<typeof blueprintResume>,
	): Promise<BlueprintOutcome> {
		const outcome = await runBlueprint(bp, vars, blueprintExec(ctx), {
			journal: journalOf(session),
			resume: resume
				? { done: resume.done, failedOrSkipped: resume.failedOrSkipped, output: resume.output }
				: undefined,
			isApproved: resume ? (n: BlueprintNode) => resume.approved.has(n.id) : undefined,
		});
		// runBlueprint journals run_finished:paused itself; the caller owns the terminal done/failed mark.
		if (session && !outcome.paused) {
			const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
			session.append("run_finished", { status: failed ? "failed" : "done" });
		}
		return outcome;
	}

	function renderBlueprint(outcome: BlueprintOutcome, runId: string | null): string {
		const body = outcome.nodes
			.map((n) => {
				const head = `=== ${n.id} [${n.kind}${n.agent ? `:${n.agent}` : ""}] -> ${n.status} ===`;
				if (n.status === "skipped")
					return `${head}\nskipped (upstream not done: ${(n.skipped_by ?? []).join(", ")})`;
				if (n.status === "awaiting_approval") return `${head}\n\u23f8 awaiting approval`;
				return `${head}\n${n.output.slice(0, 1200)}`;
			})
			.join("\n\n");
		if (outcome.paused)
			return (
				`${body}\n\n\u23f8 PAUSED — awaiting approval on: ${(outcome.awaiting ?? []).join(", ")}` +
				(runId ? `\nApprove + resume:  approve_gate({ run_id: "${runId}", gate: "<node>", approved: true })` : "")
			);
		return runId ? `${body}\n\n(durable run: ${runId})` : body;
	}

	function renderTeam(outcome: { stages: any[][] }): string {
		return outcome.stages
			.map((stage, i) => {
				const stepTexts = stage
					.map((step: any) => (step.resumed ? `[${step.agent} → resumed (done in prior run)]` : fmt(step.result)))
					.join("\n\n---\n\n");
				return `=== Stage ${i + 1} ===\n\n${stepTexts}`;
			})
			.join("\n\n");
	}

	// Resume any durable run from its log: blueprint = full DAG resume (skip done nodes, release granted
	// gates); team = skip-done re-run. Returns rendered text + the outcome.
	async function resumeRun(runId: string, ctx: any): Promise<{ text: string; outcome?: unknown; isError: boolean }> {
		const path = runEventsPath(RUNS_DIR, runId);
		if (!existsSync(path)) return { text: `run '${runId}' not found`, isError: true };
		const events = readEvents(path);
		const meta = runMeta(events);
		if (!meta) return { text: `run '${runId}' has no run_started — cannot resume`, isError: true };
		const session = RunSession.resume(path);
		if (meta.kind === "blueprint") {
			const bp = loadBlueprints(registry, process.cwd()).get(meta.name);
			if (!bp) return { text: `blueprint '${meta.name}' no longer exists`, isError: true };
			const outcome = await executeBlueprint(bp, meta.vars ?? {}, ctx, session, blueprintResume(events));
			const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
			return { text: renderBlueprint(outcome, runId), outcome, isError: failed && !outcome.paused };
		}
		if (meta.kind === "team") {
			const team = loadTeams(registry, process.cwd()).get(meta.name);
			if (!team) return { text: `team '${meta.name}' no longer exists`, isError: true };
			const st = deriveState(events);
			const done = new Set([...st.nodes].filter(([, o]) => o === "done").map(([id]) => id));
			const recorded = new Map([...st.outputs].map(([k, v]) => [k, { status: "done", artifact_excerpt: v }]));
			const outcome = await runTeam(team, meta.vars ?? {}, (a, p) => runOne(a, p, `${team.name}:${a}`, ctx), {
				journal: journalOf(session),
				skipDone: done,
				recorded,
			});
			session.append("run_finished", { status: "done" });
			return { text: renderTeam(outcome), outcome, isError: false };
		}
		return { text: `resume not supported for run kind '${meta.kind}' (ledger only)`, isError: true };
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
			try {
				// Durable session: journal the run so a crash or approval-pause is discoverable + resumable.
				const { session, runId } = startRun("blueprint", p.blueprint, { vars: p.vars ?? {} }, ctx);
				const outcome = await executeBlueprint(bp, p.vars ?? {}, ctx, session);
				const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
				return {
					content: [{ type: "text", text: renderBlueprint(outcome, runId) }],
					details: { ...outcome, runId },
					isError: failed && !outcome.paused, // a paused run is not an error — it awaits approval
				};
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
		name: "resume_run",
		label: "Resume a durable run (crashed or approval-paused)",
		description:
			"Resume a durable blueprint/team run from its append-only event log: completed nodes are NOT " +
			"re-run, granted approval gates are released. Run ids appear in the boot 'resumable-runs' event.",
		parameters: Type.Object({ run_id: Type.String({ description: "the durable run id to resume" }) }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const r = await resumeRun(p.run_id, ctx);
			return { content: [{ type: "text", text: r.text }], details: r.outcome, isError: r.isError };
		},
	});

	summon.registerTool({
		name: "approve_gate",
		label: "Approve or deny a paused run's gate (human-in-the-loop)",
		description:
			"Decide a human-approval gate on a paused durable run. approved:true releases the gate and " +
			"auto-resumes the run from where it paused; approved:false halts it. The gate id is the paused node's id.",
		parameters: Type.Object({
			run_id: Type.String(),
			gate: Type.String({ description: "the gate id (the paused node's id)" }),
			approved: Type.Boolean(),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const path = runEventsPath(RUNS_DIR, p.run_id);
			if (!existsSync(path))
				return {
					content: [{ type: "text", text: `run '${p.run_id}' not found` }],
					isError: true,
					details: undefined,
				};
			const session = RunSession.resume(path);
			session.append("approval_decided", { gate: p.gate, approved: !!p.approved });
			if (!p.approved) {
				session.append("run_finished", { status: "failed" });
				return {
					content: [{ type: "text", text: `gate '${p.gate}' DENIED — run ${p.run_id} halted` }],
					isError: false,
					details: undefined,
				};
			}
			const r = await resumeRun(p.run_id, ctx); // auto-resume now that the gate is granted
			return {
				content: [{ type: "text", text: `gate '${p.gate}' APPROVED — resuming…\n\n${r.text}` }],
				details: r.outcome,
				isError: r.isError,
			};
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
			// Durable ledger: journal each task (node_started/node_done) so a crashed fan-out is discoverable.
			const { session, runId } = startRun("fanout", "spawn_agents", {}, ctx);
			const journal = journalOf(session);
			const results = await Promise.all(
				p.tasks.map(async (t: any, i: number) => {
					const taskId = t.task_id ?? `${t.agent}-${i}`;
					journal?.({ type: "node_started", node: taskId, agent: t.agent });
					const r = await runOne(
						t.agent,
						t.prompt,
						taskId,
						ctx,
						t.verify,
						pickTransport(counts.get(t.agent) ?? 0, p.transport, isPrewarmed(t.agent)),
					);
					journal?.({
						type: "node_done",
						node: taskId,
						status: r.status === "done" ? "done" : "failed",
						output_excerpt: String(r.artifact_excerpt ?? "").slice(0, 1500),
					});
					return r;
				}),
			);
			if (session) session.append("run_finished", { status: "done" });
			return {
				content: [{ type: "text", text: results.map(fmt).join("\n\n---\n\n") }],
				details: { results, runId },
			};
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
