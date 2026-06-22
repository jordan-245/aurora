// Offline unit tests for the teams module (validateTeam / fillTemplate / runTeam / loadTeams). Run:
//   node --experimental-strip-types --test test/teams.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentBundle } from "../src/core.ts";
import { fillTemplate, loadTeams, runTeam, type Team, validateTeam } from "../src/teams.ts";

// ── Fake registry ─────────────────────────────────────────────────────────────
function makeBundle(name: string): AgentBundle {
	return {
		name,
		role: `${name} role`,
		model_tier: "fast",
		tools: ["read"],
		output_contract: { required_sections: [`## ${name}`] },
	};
}
const fakeReg = new Map<string, AgentBundle>([
	["builder", makeBundle("builder")],
	["reviewer", makeBundle("reviewer")],
	["scout", makeBundle("scout")],
	["orchestrator", { ...makeBundle("orchestrator"), may_spawn: true }],
]);

// ── validateTeam ──────────────────────────────────────────────────────────────

test("validateTeam rejects unknown agent", () => {
	const team: Team = {
		name: "bad",
		stages: [[{ agent: "ghost", prompt: "do something" }]],
	};
	assert.throws(() => validateTeam(team, fakeReg), /unknown agent/);
});

test("validateTeam rejects empty stages array", () => {
	const team: Team = { name: "bad", stages: [] };
	assert.throws(() => validateTeam(team, fakeReg), /missing name\/stages/);
});

test("validateTeam rejects a stage that is an empty array", () => {
	const team: Team = {
		name: "bad",
		stages: [
			[], // stage 0 is empty — must throw
			[{ agent: "builder", prompt: "x" }],
		],
	};
	assert.throws(() => validateTeam(team, fakeReg), /must be a non-empty array/);
});

test("validateTeam rejects a may_spawn agent as a step", () => {
	const team: Team = {
		name: "bad-delegation",
		stages: [[{ agent: "orchestrator", prompt: "do something" }]],
	};
	assert.throws(() => validateTeam(team, fakeReg), /delegation/);
});

test("validateTeam accepts a valid team", () => {
	const team: Team = {
		name: "ok",
		stages: [[{ agent: "builder", prompt: "build {{task}}" }], [{ agent: "reviewer", prompt: "review {{task}}" }]],
	};
	assert.doesNotThrow(() => validateTeam(team, fakeReg));
});

// ── fillTemplate ──────────────────────────────────────────────────────────────

test("fillTemplate fills vars", () => {
	assert.equal(fillTemplate("hi {{task}}", { task: "X" }), "hi X");
});

test("fillTemplate replaces multiple and whitespace-padded placeholders", () => {
	assert.equal(fillTemplate("{{ a }} and {{b}}", { a: "1", b: "2" }), "1 and 2");
});

test("fillTemplate fail-closes on a missing var", () => {
	assert.throws(() => fillTemplate("{{nope}}", {}), /undefined var 'nope'/);
});

// ── runTeam ───────────────────────────────────────────────────────────────────

test("runTeam runs stages SEQUENTIALLY and steps within a stage in PARALLEL", async () => {
	const order: string[] = [];

	// stage 0: [builder-A], stage 1: [reviewer-B, scout-C]
	const team: Team = {
		name: "test",
		stages: [
			[{ agent: "builder", prompt: "A: {{task}}" }],
			[
				{ agent: "reviewer", prompt: "B: {{task}}" },
				{ agent: "scout", prompt: "C: {{task}}" },
			],
		],
	};

	const DELAY_MS = 30; // enough for deterministic ordering without being slow
	const runStep = async (agent: string, prompt: string) => {
		order.push(`start:${agent}`);
		await new Promise<void>((r) => setTimeout(r, DELAY_MS));
		order.push(`end:${agent}`);
		return { agent, prompt };
	};

	const result = await runTeam(team, { task: "myTask" }, runStep);

	// Sequential: builder (stage 0) must fully complete before reviewer/scout (stage 1) start
	const endA = order.indexOf("end:builder");
	const startB = order.indexOf("start:reviewer");
	const startC = order.indexOf("start:scout");
	assert.ok(endA >= 0 && startB >= 0 && startC >= 0, `all agents must run — got: ${order.join()}`);
	assert.ok(endA < startB, `builder must complete before reviewer starts (order=${order.join()})`);
	assert.ok(endA < startC, `builder must complete before scout starts (order=${order.join()})`);

	// Parallel: reviewer and scout must BOTH start before either finishes
	const endB = order.indexOf("end:reviewer");
	const endC = order.indexOf("end:scout");
	const bothStarted = Math.max(startB, startC); // position after which both are running
	const firstEnded = Math.min(endB, endC); // position of the earliest finish
	assert.ok(bothStarted < firstEnded, `reviewer and scout must both start before either ends (order=${order.join()})`);

	// Shape
	assert.equal(result.team, "test");
	assert.equal(result.stages.length, 2);
	assert.equal(result.stages[0].length, 1);
	assert.equal(result.stages[1].length, 2);

	// Filled prompts
	assert.equal(result.stages[0][0].prompt, "A: myTask");
	const stage1Prompts = result.stages[1].map((s) => s.prompt).sort();
	assert.deepEqual(stage1Prompts, ["B: myTask", "C: myTask"]);
});

// ── loadTeams ─────────────────────────────────────────────────────────────────

test("loadTeams loads + validates from a temp dir fixture", () => {
	const tmp = mkdtempSync(join(tmpdir(), "harness-teams-"));
	const saved = process.env.HARNESS_TEAMS_DIR;
	try {
		// ── valid team ────────────────────────────────────────────────────────────
		process.env.HARNESS_TEAMS_DIR = tmp;
		writeFileSync(
			join(tmp, "t1.json"),
			JSON.stringify({
				name: "t1",
				description: "fixture",
				stages: [[{ agent: "builder", prompt: "do {{task}}" }]],
			}),
		);
		const teams = loadTeams(fakeReg);
		assert.ok(teams.has("t1"), "should load the fixture team");
		assert.equal(teams.get("t1")!.name, "t1");

		// ── malformed team (unknown agent) ────────────────────────────────────────
		const tmp2 = mkdtempSync(join(tmpdir(), "harness-teams-bad-"));
		try {
			process.env.HARNESS_TEAMS_DIR = tmp2;
			writeFileSync(
				join(tmp2, "bad.json"),
				JSON.stringify({
					name: "bad",
					stages: [[{ agent: "ghost", prompt: "x" }]],
				}),
			);
			assert.throws(() => loadTeams(fakeReg), /unknown agent/);
		} finally {
			rmSync(tmp2, { recursive: true, force: true });
		}
	} finally {
		if (saved === undefined) delete process.env.HARNESS_TEAMS_DIR;
		else process.env.HARNESS_TEAMS_DIR = saved;
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ── durable journaling + resume (Phase 3) ──
test("runTeam journals each step and skips already-done steps on resume", async () => {
	const team: Team = {
		name: "t",
		stages: [[{ agent: "scout", prompt: "a" }], [{ agent: "builder", prompt: "b" }]],
	};
	const ran: string[] = [];
	const events: any[] = [];
	const runStep = async (agent: string) => {
		ran.push(agent);
		return { status: "done", artifact_excerpt: `${agent}-out` };
	};
	// Pass 1: full run, journaling every step.
	await runTeam(team, {}, runStep, { journal: (e) => events.push(e) });
	assert.deepEqual(ran, ["scout", "builder"]);
	assert.ok(events.some((e) => e.type === "node_started" && e.node === "s0.0"));
	assert.ok(events.some((e) => e.type === "node_done" && e.node === "s1.0" && e.status === "done"));

	// Pass 2 (resume): step s0.0 recorded done → NOT re-run; only s1.0 executes.
	ran.length = 0;
	const out = await runTeam(team, {}, runStep, {
		skipDone: new Set(["s0.0"]),
		recorded: new Map([["s0.0", { status: "done", artifact_excerpt: "prior" }]]),
	});
	assert.deepEqual(ran, ["builder"], "only the not-yet-done step re-runs");
	assert.equal(out.stages[0][0].resumed, true);
	assert.equal(out.stages[0][0].result.artifact_excerpt, "prior");
});
