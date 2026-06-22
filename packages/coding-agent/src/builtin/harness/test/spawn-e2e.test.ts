// End-to-end harness tests (A4): drive the REAL Pi extension (spawn_quorum / plan_and_run /
// resume_run) through the REAL subprocess boundary, using a scripted fake CLI (fixtures/fake-cli.mjs)
// as SUMMON_BIN. This closes the gap the in-process FAUX provider can't cover — it intercepts only the
// parent session, never the child `summon` spawns. No provider, network, or auth is touched.
//
// Env (paths.ts reads several at import time) is set BEFORE the dynamic import of the extension, and a
// fresh stub ExtensionAPI is built per scenario so HARNESS_* feature flags can differ per call (the
// flags are read inside harness() at registration, not at module load).
// Run: node --experimental-strip-types --test test/spawn-e2e.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, "fixtures", "fake-cli.mjs");

// dynamically-loaded after env is set
let harness: (summon: any) => void;
let RUNS_DIR: string;
let runEventsPath: (dir: string, id: string) => string;
let RunSession: any;

let agentsDir: string;
let configDir: string;
let projectDir: string;
const prevCwd = process.cwd();

function writeAgent(name: string, tier: string, tools: string[], sections: string[]): void {
	const dir = join(agentsDir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "agent.json"),
		JSON.stringify({
			name,
			role: `${name} test role`,
			model_tier: tier,
			tools,
			output_contract: { required_sections: sections },
		}),
	);
}

// A stub ExtensionAPI capturing registered tools + emitted agent-events + the shutdown hook.
function makeSummon() {
	const tools = new Map<string, any>();
	const events: any[] = [];
	let shutdown: (() => unknown) | undefined;
	const api = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (_n: string, _c: any) => {},
		events: { emit: (_topic: string, payload: any) => events.push(payload) },
		on: (ev: string, fn: () => unknown) => {
			if (ev === "session_shutdown") shutdown = fn;
		},
	};
	return { api, tools, events, runShutdown: async () => shutdown?.() };
}

const ctx = { sessionId: "e2e" };

before(async () => {
	agentsDir = mkdtempSync(join(tmpdir(), "e2e-agents-"));
	configDir = mkdtempSync(join(tmpdir(), "e2e-config-"));
	projectDir = mkdtempSync(join(tmpdir(), "e2e-proj-"));
	writeFileSync(join(projectDir, ".harness.json"), "{}"); // make projectDir the resolved root

	// the fixture is spawned directly via its shebang → needs the exec bit.
	chmodSync(FAKE_CLI, 0o755);

	// test registry: a read-only worker, a reviewer (quorum judge fallback), a standard-tier shedder.
	writeAgent("tester", "fast", ["read", "grep"], ["## result"]);
	writeAgent("reviewer", "fast", ["read", "grep"], ["## verdict"]);
	writeAgent("shedder", "standard", ["read", "grep"], ["## result"]);

	// paths.ts derives RUNS_DIR / AGENTS_DIR / AGENT_BIN from these at import time.
	process.env.SUMMON_BIN = FAKE_CLI;
	process.env.HARNESS_AGENTS_DIR = agentsDir;
	process.env.SUMMON_CODING_AGENT_DIR = configDir;
	process.env.HARNESS_DURABLE = "1";
	process.env.HARNESS_NO_CACHE = "1"; // each spawn really runs (no within-run cache short-circuit)
	process.env.HARNESS_AUTOSCALE_ACT = "0"; // actuation OFF by default in tests; the actuation/shedding cases opt in
	process.chdir(projectDir);

	harness = (await import("../extension/spawn-agent.ts")).default;
	RUNS_DIR = (await import("../src/paths.ts")).RUNS_DIR;
	runEventsPath = (await import("../src/runstore.ts")).runEventsPath;
	RunSession = (await import("../src/session.ts")).RunSession;
});

after(() => {
	process.chdir(prevCwd);
	for (const d of [agentsDir, configDir, projectDir]) rmSync(d, { recursive: true, force: true });
});

// ── spawn_agent: the real subprocess round-trip ─────────────────────────────────

test("e2e spawn_agent: drives the fake CLI subprocess and returns a done result", async () => {
	delete process.env.HARNESS_AUTOSCALE; // observe-only ON (default); actuation inherits "0" from before()
	const { api, tools, runShutdown } = makeSummon();
	harness(api);
	try {
		const r = await tools.get("spawn_agent").execute("id", { agent: "tester", prompt: "do X" }, null, null, ctx);
		assert.equal(r.isError, false);
		assert.equal(r.details.status, "done", "contract '## result' satisfied via the fake CLI");
		assert.match(r.content[0].text, /tester → done/);
	} finally {
		await runShutdown();
	}
});

// ── observe-only autoscaler is ON BY DEFAULT (B3) and must stay byte-silent when idle ───────────

test("e2e observe-only default: idle emits NO autoscale events (jitter-safe); demand surfaces them", async () => {
	delete process.env.HARNESS_AUTOSCALE; // default ⇒ observe-only ON
	process.env.HARNESS_AUTOSCALE_ACT = "0"; // actuation explicitly OFF — this is the observe-only case
	process.env.HARNESS_AUTOSCALE_TICK_MS = "25"; // fast ticks so several elapse during the test
	const { api, tools, events, runShutdown } = makeSummon();
	harness(api);
	try {
		await new Promise((r) => setTimeout(r, 150)); // ~6 idle ticks
		assert.equal(
			events.filter((e) => e.t === "autoscale").length,
			0,
			"idle controller must stay byte-silent (no no-op ticks ⇒ no idle repaint/jitter)",
		);
		await tools.get("spawn_agent").execute("id", { agent: "tester", prompt: "work" }, null, null, ctx);
		assert.ok(
			events.filter((e) => e.t === "autoscale").length >= 1,
			"real demand surfaces fleet telemetry (the observe-only default earns its keep)",
		);
	} finally {
		delete process.env.HARNESS_AUTOSCALE_TICK_MS;
		await runShutdown();
	}
});

// ── actuation is ON BY DEFAULT (B3): a concurrent burst grows a warm pool, then quiesces ────────

test("e2e actuation default-on: concurrent burst routes to the warm pool and the controller actuates", async () => {
	delete process.env.HARNESS_AUTOSCALE; // observe ON
	delete process.env.HARNESS_AUTOSCALE_ACT; // → actuation ON by default (the flip under test)
	process.env.HARNESS_AUTOSCALE_TICK_MS = "25";
	const { api, tools, events, runShutdown } = makeSummon();
	harness(api);
	try {
		// 6 same-bundle tasks forced through the warm rpc pool (exercises the faithful fake rpc transport).
		const tasks = Array.from({ length: 6 }, (_v, i) => ({ agent: "tester", prompt: `burst ${i}` }));
		const r = await tools.get("spawn_agents").execute("id", { tasks, transport: "pool" }, null, null, ctx);
		assert.equal(r.isError ?? false, false);
		assert.equal((r.content[0].text.match(/tester → done/g) ?? []).length, 6, "all 6 completed via the pool");
		// the actuating controller made at least one real scaling decision (prewarm/grow) under the burst.
		const actions = events.filter((e) => e.t === "autoscale").flatMap((e: any) => e.ticks.map((t: any) => t.action));
		assert.ok(
			actions.some((a: string) => a === "prewarm" || a === "grow"),
			`actuation should grow/prewarm the pool under load; saw actions: ${[...new Set(actions)].join(",") || "(none)"}`,
		);
	} finally {
		delete process.env.HARNESS_AUTOSCALE_TICK_MS;
		process.env.HARNESS_AUTOSCALE_ACT = "0"; // restore the file default for later tests
		await runShutdown(); // stops the fleet timer + drains the warm pool
	}
});

// ── spawn_quorum: K candidates, verify-filter, majority vote ─────────────────────

test("e2e spawn_quorum: 3 identical candidates ⇒ majority winner via vote (no judge)", async () => {
	const { api, tools, runShutdown } = makeSummon();
	harness(api);
	try {
		const r = await tools
			.get("spawn_quorum")
			.execute("id", { agent: "tester", prompt: "solve it", n: 3 }, null, null, ctx);
		assert.equal(r.isError, false, "a winner was chosen");
		assert.equal(r.details.agreement, "majority");
		assert.equal(r.details.decidedBy, "vote");
		assert.equal(r.details.survivors.length, 3, "all 3 passed verify+contract");
		assert.match(r.content[0].text, /QUORUM: majority via vote \(3\/3 survived\)/);
	} finally {
		await runShutdown();
	}
});

// ── plan_and_run: dry-run synthesises + validates a DAG from the planner subprocess ──

test("e2e plan_and_run (dry): planner subprocess → validated blueprint, not executed", async () => {
	delete process.env.HARNESS_PLAN_RUN; // execution disabled ⇒ dry-run forced
	const { api, tools, runShutdown } = makeSummon();
	harness(api);
	try {
		const r = await tools.get("plan_and_run").execute("id", { goal: "ship the thing" }, null, null, ctx);
		assert.equal(r.isError, false);
		assert.match(r.content[0].text, /PLAN: auto-demo \(1 nodes, dry run\)/);
		assert.equal(r.details.blueprint.nodes.length, 1);
		assert.equal(r.details.blueprint.nodes[0].agent, "tester");
	} finally {
		await runShutdown();
	}
});

test("e2e plan_and_run (live): HARNESS_PLAN_RUN=1 executes the generated DAG", async () => {
	process.env.HARNESS_PLAN_RUN = "1";
	const { api, tools, runShutdown } = makeSummon();
	harness(api);
	try {
		const r = await tools
			.get("plan_and_run")
			.execute("id", { goal: "ship the thing", dry_run: false }, null, null, ctx);
		assert.equal(r.isError, false, "generated DAG ran to completion");
		assert.match(r.content[0].text, /step1 \[agent:tester\] -> done/);
	} finally {
		delete process.env.HARNESS_PLAN_RUN;
		await runShutdown();
	}
});

// ── A3: cross-process resume of a GENERATED (not-on-disk) blueprint ──────────────

test("e2e resume_run: reconstructs a generated blueprint from run meta (A3) — not loadBlueprints", async () => {
	// Simulate a crash mid-run: a generated DAG journaled with its blueprint embedded, no run_finished.
	const runId = "blueprint-auto-resumed-e2e-123";
	const bp = { name: "auto-resumed", nodes: [{ id: "step1", agent: "tester", prompt: "go" }] };
	const s = RunSession.create(runEventsPath(RUNS_DIR, runId));
	s.append("run_started", { kind: "blueprint", name: bp.name, vars: {}, generated: true, blueprint: bp });
	s.append("node_started", { node: "step1", agent: "tester" }); // started, never finished → crashed

	const { api, tools, runShutdown } = makeSummon();
	harness(api);
	try {
		const r = await tools.get("resume_run").execute("id", { run_id: runId }, null, null, ctx);
		// Without A3 this errors "blueprint 'auto-resumed' no longer exists" (it's not on disk).
		assert.equal(r.isError, false, "resumed from the embedded blueprint, not disk");
		assert.match(r.content[0].text, /step1 \[agent:tester\] -> done/);
	} finally {
		await runShutdown();
	}
});

// ── A1: load-shedding actuation degrades a hot spawn one tier (visibly) ───────────

test("e2e spawn_agent shedding: ACTUATING + hot window ⇒ tier downshift + shedding event", async () => {
	process.env.HARNESS_AUTOSCALE = "1";
	process.env.HARNESS_AUTOSCALE_ACT = "1";
	process.env.HARNESS_AUTOSCALE_SHED_PCT = "0"; // shed every spawn (windowPct ≥ 0 always)
	const { api, tools, events, runShutdown } = makeSummon();
	harness(api);
	try {
		const r = await tools.get("spawn_agent").execute("id", { agent: "shedder", prompt: "heavy" }, null, null, ctx);
		assert.equal(r.details.status, "done");
		const shedding = events.find((e) => e.t === "shedding" && e.agent === "shedder");
		assert.ok(shedding, "a shedding event was emitted (the trade-off is visible)");
		assert.equal(shedding.from, "standard");
		assert.equal(shedding.to, "fast", "standard degraded one tier to fast");
		const spawned = events.find((e) => e.t === "spawned" && e.agent === "shedder");
		assert.equal(spawned.model, "fast", "the spawn actually ran at the degraded tier");
	} finally {
		delete process.env.HARNESS_AUTOSCALE;
		delete process.env.HARNESS_AUTOSCALE_ACT;
		delete process.env.HARNESS_AUTOSCALE_SHED_PCT;
		await runShutdown();
	}
});
