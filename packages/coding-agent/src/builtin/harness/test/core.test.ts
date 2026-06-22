// Offline unit tests for the harness core (validator + contract). Run:
//   node --experimental-strip-types --test test/core.test.ts

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync as writeFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type AgentBundle,
	appendExpertiseNote,
	assertSpawnAuth,
	buildSystemPrompt,
	buildWorkerArgs,
	checkContract,
	estimateTokens,
	finalizeResult,
	forceOAuthRouting,
	loadExpertise,
	loadExpertiseMemory,
	loadRegistry,
	parseExpertiseNote,
	parseVerdict,
	registryDigest,
	registryIndex,
	registryView,
	reviewDecision,
	runWithReview,
	type SpawnResult,
	SYS_HEADER,
	spawnEnv,
	validateBundle,
	WindowGovernor,
	WORKER_SEAL_FLAGS,
	withRetry,
	writeRegistryIndex,
} from "../src/core.ts";

const base: AgentBundle = {
	name: "x",
	role: "r",
	model_tier: "fast",
	tools: ["read"],
	output_contract: { required_sections: ["## a"] },
};

// ── worker spawn argv: seal + transport parity ──────────────────────────────────
// These lock the structural guarantee that EVERY spawned worker is sealed (no
// extension/skill/prompt/theme/context discovery) so a future edit can't silently
// unseal a sub-agent. Both transports must route through buildWorkerArgs.

test("buildWorkerArgs seals every worker against ambient discovery", () => {
	const args = buildWorkerArgs(base, ["-p", "--no-session", "--mode", "json"]);
	for (const flag of WORKER_SEAL_FLAGS) assert.ok(args.includes(flag), `missing seal flag ${flag}`);
	// The seal must cover discovery of extensions, skills, prompts, themes, and context files.
	assert.deepEqual([...WORKER_SEAL_FLAGS].sort(), [
		"--no-context-files",
		"--no-extensions",
		"--no-prompt-templates",
		"--no-skills",
		"--no-themes",
	]);
});

test("buildWorkerArgs carries the mode head, model, system prompt, and tool allowlist", () => {
	const args = buildWorkerArgs({ ...base, tools: ["read", "grep"] }, ["--mode", "rpc", "--no-session"]);
	assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep");
	assert.ok(args.includes("--system-prompt"));
	assert.ok(args.includes("--model"));
});

test("buildWorkerArgs loads the write-guard only for write/exec-capable workers", () => {
	const readOnly = buildWorkerArgs({ ...base, tools: ["read"] }, ["-p"]);
	assert.ok(!readOnly.includes("-e"), "read-only worker must not load the guard extension");
	for (const tool of ["bash", "write", "edit"]) {
		const args = buildWorkerArgs({ ...base, tools: ["read", tool] }, ["-p"]);
		assert.ok(args.includes("-e"), `${tool}-capable worker must load the guard extension`);
	}
});

test("valid bundle passes", () => {
	assert.doesNotThrow(() => validateBundle(base));
});

test("orchestrator with bash is rejected (delegate-never-execute)", () => {
	assert.throws(() => validateBundle({ ...base, may_spawn: true, tools: ["read", "bash"] }), /must NOT have write/);
});

test("non-orchestrator with spawn_agent is rejected", () => {
	assert.throws(() => validateBundle({ ...base, tools: ["read", "spawn_agent"] }), /only the orchestrator/);
});

test("write-capable bundle scoped into a DEFAULT-protected path is rejected", () => {
	assert.throws(
		() => validateBundle({ ...base, tools: ["read", "write"], context_globs: ["secrets/x"] }),
		/protected path/,
	);
});

test("bad model_tier is rejected", () => {
	assert.throws(() => validateBundle({ ...base, model_tier: "turbo" as any }), /model_tier/);
});

test("missing output_contract is rejected", () => {
	assert.throws(() => validateBundle({ ...base, output_contract: { required_sections: [] } }), /required_sections/);
});

test("contract: required sections present => pass", () => {
	assert.equal(
		checkContract("## findings\nx\n## confidence\nhigh", { required_sections: ["## findings", "## confidence"] })
			.passed,
		true,
	);
});

test("contract: missing section => fail with the missing name", () => {
	const r = checkContract("## findings only", { required_sections: ["## findings", "## confidence"] });
	assert.equal(r.passed, false);
	assert.deepEqual(r.missing, ["## confidence"]);
});

test("contract: forbidden substring => fail", () => {
	assert.equal(checkContract("## a\nTODO later", { required_sections: ["## a"], forbidden: ["TODO"] }).passed, false);
});

test("all seed bundles (incl. orchestrator) load + validate", () => {
	const reg = loadRegistry(join(import.meta.dirname, "..", "agents"));
	assert.equal(reg.size, 4);
	for (const n of ["scout", "builder", "reviewer", "orchestrator"]) assert.ok(reg.has(n), n);
	assert.equal(reg.get("orchestrator")!.may_spawn, true);
});

test("orchestrator (may_spawn) with spawn_agent/spawn_agents is valid", () => {
	assert.doesNotThrow(() =>
		validateBundle({ ...base, may_spawn: true, tools: ["read", "spawn_agent", "spawn_agents"] }),
	);
});

test("non-orchestrator with spawn_agents is rejected", () => {
	assert.throws(() => validateBundle({ ...base, tools: ["read", "spawn_agents"] }), /only the orchestrator/);
});

test("validator: a worker bundle with run_team is rejected", () => {
	assert.throws(() => validateBundle({ ...base, tools: ["read", "run_team"] }), /only the orchestrator/);
});

test("validator: an orchestrator (may_spawn) with run_team is accepted", () => {
	assert.doesNotThrow(() =>
		validateBundle({
			...base,
			may_spawn: true,
			tools: ["read", "run_team"],
			output_contract: { required_sections: ["## x"] },
		}),
	);
});

test("per-project protected list rejects write-bundle scoped into it", () => {
	assert.throws(
		() => validateBundle({ ...base, tools: ["read", "write"], context_globs: ["migrations/x"] }, ["migrations/"]),
		/protected/,
	);
	assert.doesNotThrow(() =>
		validateBundle({ ...base, tools: ["read", "write"], context_globs: ["src/x"] }, ["migrations/"]),
	);
});

// ── withRetry tests (frozen, deterministic, no real subprocess) ─────────────
const mk = (status: SpawnResult["status"]): SpawnResult => ({
	agent: "x",
	status,
	artifact_excerpt: "",
	contract: { passed: status === "done", missing: [] },
	meta: { model: "m", elapsed_s: 0, bytes: 0 },
});

test("withRetry: default 1 attempt, no retry on failure", async () => {
	let calls = 0;
	const result = await withRetry(1, async () => {
		calls++;
		return mk("failed");
	});
	assert.equal(calls, 1);
	assert.equal(result.status, "failed");
});

test("withRetry: stops on first success", async () => {
	let calls = 0;
	const result = await withRetry(3, async () => {
		calls++;
		return mk(calls < 2 ? "failed" : "done");
	});
	assert.equal(calls, 2);
	assert.equal(result.status, "done");
});

test("withRetry: exhausts then returns the LAST result", async () => {
	let calls = 0;
	let lastReturned: SpawnResult | undefined;
	const result = await withRetry(3, async () => {
		calls++;
		lastReturned = mk("contract_violation");
		return lastReturned;
	});
	assert.equal(calls, 3);
	assert.deepEqual(result, lastReturned);
});

test("withRetry: coerces 0/undefined to 1 attempt", async () => {
	let calls = 0;
	await withRetry(0, async () => {
		calls++;
		return mk("failed");
	});
	assert.equal(calls, 1);
});

test("withRetry: passes prev result into the next attempt", async () => {
	let firstResult: SpawnResult | undefined;
	let receivedPrev: SpawnResult | undefined;
	await withRetry(2, async (attempt, prev) => {
		if (attempt === 1) {
			firstResult = mk("failed");
			return firstResult;
		}
		receivedPrev = prev;
		return mk("done");
	});
	assert.ok(firstResult !== undefined);
	assert.deepEqual(receivedPrev, firstResult);
});

// ── loadExpertise tests (frozen, no subprocess) ─────────────────────────────────────────────────
test("loadExpertise: no context_globs → empty string", () => {
	// no context_globs field
	assert.equal(loadExpertise({ ...base, _dir: tmpdir() }), "");
	// no _dir
	assert.equal(loadExpertise({ ...base, context_globs: ["expertise.md"] }), "");
});

test("loadExpertise: literal file path is read and included", () => {
	const dir = join(tmpdir(), `harness-test-${Date.now()}-lit`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFile(join(dir, "expertise.md"), "SECRET_MARKER content");
		const bundle: AgentBundle = { ...base, _dir: dir, context_globs: ["expertise.md"] };
		const result = loadExpertise(bundle);
		assert.ok(result.includes("## Expertise context"), "missing header");
		assert.ok(result.includes("SECRET_MARKER"), "missing file content");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadExpertise: single-level glob matches multiple files", () => {
	const dir = join(tmpdir(), `harness-test-${Date.now()}-glob`);
	try {
		mkdirSync(join(dir, "notes"), { recursive: true });
		writeFile(join(dir, "notes", "a.md"), "AAA content");
		writeFile(join(dir, "notes", "b.md"), "BBB content");
		writeFile(join(dir, "notes", "ignore.txt"), "CCC content");
		const bundle: AgentBundle = { ...base, _dir: dir, context_globs: ["notes/*.md"] };
		const result = loadExpertise(bundle);
		assert.ok(result.includes("AAA"), "missing AAA");
		assert.ok(result.includes("BBB"), "missing BBB");
		assert.ok(!result.includes("CCC"), "should not include CCC from ignore.txt");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadExpertise: missing glob/dir → empty string", () => {
	const dir = join(tmpdir(), `harness-test-${Date.now()}-missing`);
	mkdirSync(dir, { recursive: true });
	try {
		const bundle: AgentBundle = { ...base, _dir: dir, context_globs: ["nope/*.md"] };
		assert.equal(loadExpertise(bundle), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadExpertise: respects maxBytes cap", () => {
	const dir = join(tmpdir(), `harness-test-${Date.now()}-cap`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFile(join(dir, "big.md"), "X".repeat(500));
		const bundle: AgentBundle = { ...base, _dir: dir, context_globs: ["big.md"] };
		const result = loadExpertise(bundle, 200);
		assert.ok(result.length <= 260, `result too long: ${result.length}`);
		assert.ok(result.endsWith("\u2026[expertise truncated]"), "missing truncation marker");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── parseVerdict tests (frozen) ─────────────────────────────────────────────
test("parseVerdict: verdict section with APPROVE returns APPROVE", () => {
	assert.equal(parseVerdict("## verdict\nAPPROVE — 24/24"), "APPROVE");
});

test("parseVerdict: verdict section with REJECT returns REJECT", () => {
	assert.equal(parseVerdict("## verdict\nREJECT: signature changed"), "REJECT");
});

test("parseVerdict: both APPROVE and REJECT present → REJECT wins (fail-closed)", () => {
	// The phrase \"APPROVE or REJECT\" contains both tokens; REJECT must win
	assert.equal(parseVerdict("## verdict\nAPPROVE or REJECT"), "REJECT");
});

test("parseVerdict: no verdict heading and no tokens → UNKNOWN", () => {
	assert.equal(parseVerdict("just some analysis text with no decision"), "UNKNOWN");
});

// ── reviewDecision tests (frozen) ────────────────────────────────────────
test("reviewDecision: build failed → approved false, reason mentions build status", () => {
	const d = reviewDecision("failed");
	assert.equal(d.approved, false);
	assert.ok(d.reason.includes("failed"), `reason should mention 'failed': ${d.reason}`);
});

test("reviewDecision: build done + APPROVE text → approved true", () => {
	const d = reviewDecision("done", "## verdict\nAPPROVE: all checks pass");
	assert.equal(d.approved, true);
});

test("reviewDecision: build done + REJECT text → approved false", () => {
	const d = reviewDecision("done", "## verdict\nREJECT: missing tests");
	assert.equal(d.approved, false);
});

test("reviewDecision: build done + undefined reviewText → approved false", () => {
	const d = reviewDecision("done", undefined);
	assert.equal(d.approved, false);
});

test("reviewDecision: build done + verdict-less text → approved false (fail-closed)", () => {
	const d = reviewDecision("done", "looks good to me");
	assert.equal(d.approved, false);
});

// ── runWithReview tests (frozen, inject fakes) ──────────────────────────────
test("runWithReview: build failed → review not called, approved false", async () => {
	let reviewed = false;
	const outcome = await runWithReview(
		async () => mk("failed"),
		async () => {
			reviewed = true;
			return mk("done");
		},
	);
	assert.equal(reviewed, false, "review fn must not be called when build fails");
	assert.equal(outcome.approved, false);
	assert.equal(outcome.review, undefined);
});

test("runWithReview: build done + reviewer APPROVE → approved true, review present", async () => {
	const outcome = await runWithReview(
		async () => mk("done"),
		async () => ({ ...mk("done"), artifact_excerpt: "## verdict\nAPPROVE" }),
	);
	assert.equal(outcome.approved, true);
	assert.ok(outcome.review !== undefined, "review result should be present");
});

test("runWithReview: build done + reviewer REJECT → approved false", async () => {
	const outcome = await runWithReview(
		async () => mk("done"),
		async () => ({ ...mk("done"), artifact_excerpt: "## verdict\nREJECT" }),
	);
	assert.equal(outcome.approved, false);
});

test("runWithReview: enabled=false + build done → review not called, approved true", async () => {
	let reviewed = false;
	const outcome = await runWithReview(
		async () => mk("done"),
		async () => {
			reviewed = true;
			return mk("done");
		},
		{ enabled: false },
	);
	assert.equal(reviewed, false, "review fn must not be called when review is disabled");
	assert.equal(outcome.approved, true);
	assert.equal(outcome.review, undefined);
});

// ── buildSystemPrompt tests ────────────────────────────────────────────────────────
test("buildSystemPrompt: includes header, role, and contract sections", () => {
	// base has no context_globs → no expertise block
	const result = buildSystemPrompt({ ...base });
	assert.ok(result.includes(SYS_HEADER), "missing SYS_HEADER");
	assert.ok(result.includes(base.role), "missing role");
	for (const s of base.output_contract.required_sections)
		assert.ok(result.includes(s), `missing required section: ${s}`);
	assert.ok(!result.includes("## Expertise context"), "should not have expertise when no context_globs");
});

test("buildSystemPrompt: includes expertise when context_globs resolve", () => {
	const dir = join(tmpdir(), `harness-test-bsp-${Date.now()}`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFile(join(dir, "f.md"), "XMARKER content");
		const bundle: AgentBundle = { ...base, _dir: dir, context_globs: ["f.md"] };
		const result = buildSystemPrompt(bundle);
		assert.ok(result.includes("XMARKER"), "missing XMARKER");
		assert.ok(result.includes("## Expertise context"), "missing expertise header");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── finalizeResult tests ─────────────────────────────────────────────────────
const frBundle: AgentBundle = {
	name: "x",
	role: "r",
	model_tier: "fast",
	tools: ["read"],
	output_contract: { required_sections: ["## findings"] },
};
const completeText = "## findings\nok";

test("finalizeResult: code 0 + complete text → status done, contract passed", () => {
	const r = finalizeResult(frBundle, completeText, 0, {}, Date.now(), "m");
	assert.equal(r.status, "done");
	assert.equal(r.contract.passed, true);
});

test("finalizeResult: code 0 + missing section → status contract_violation", () => {
	const r = finalizeResult(frBundle, "no sections here", 0, {}, Date.now(), "m");
	assert.equal(r.status, "contract_violation");
});

test("finalizeResult: code null → timeout; code 1 → failed", () => {
	assert.equal(finalizeResult(frBundle, "", null, {}, Date.now(), "m").status, "timeout");
	assert.equal(finalizeResult(frBundle, "", 1, {}, Date.now(), "m").status, "failed");
});

test("finalizeResult: code 0 + complete text + verify=true → verify.passed true, status done", () => {
	const r = finalizeResult(frBundle, completeText, 0, { verify: "true" }, Date.now(), "m");
	assert.equal(r.status, "done");
	assert.equal(r.verify?.passed, true);
});

test("finalizeResult: code 0 + complete text + verify=false → verify.passed false, status verify_failed", () => {
	const r = finalizeResult(frBundle, completeText, 0, { verify: "false" }, Date.now(), "m");
	assert.equal(r.status, "verify_failed");
	assert.equal(r.verify?.passed, false);
});

test("finalizeResult: code 0 + complete text + destructive verify → blocked, verify_failed", () => {
	const r = finalizeResult(frBundle, completeText, 0, { verify: "rm -rf /" }, Date.now(), "m");
	assert.equal(r.status, "verify_failed");
	assert.equal(r.verify?.passed, false);
	const out = (r.verify?.output ?? "").toLowerCase();
	assert.ok(
		out.includes("blocked") || out.includes("destructive"),
		`output should mention blocked/destructive: ${r.verify?.output}`,
	);
});

test("registryView: sorted ascending, typed rows, contains seed agents", () => {
	const reg = loadRegistry(join(import.meta.dirname, "..", "agents"));
	const rows = registryView(reg);
	// (a) sorted ascending by name
	for (let i = 1; i < rows.length; i++)
		assert.ok(rows[i - 1].name <= rows[i].name, `not sorted at index ${i}: ${rows[i - 1].name} > ${rows[i].name}`);
	// (b) each row has the expected keys with correct types
	for (const row of rows) {
		assert.equal(typeof row.name, "string");
		assert.equal(typeof row.model_tier, "string");
		assert.ok(Array.isArray(row.tools), `tools is not an array for ${row.name}`);
		assert.ok(Array.isArray(row.contract_sections), `contract_sections is not an array for ${row.name}`);
		assert.equal(typeof row.may_spawn, "boolean");
	}
	// (c) contains expected seed agents (do not hard-code total count)
	const names = rows.map((r) => r.name);
	for (const expected of ["builder", "reviewer", "scout"])
		assert.ok(names.includes(expected), `missing seed agent: ${expected}`);
});

// ── spawn auth policy (BYO-key default + opt-in OAuth canary) ───────────────────

function withForceOAuth<T>(value: string | undefined, fn: () => T): T {
	const saved = process.env.SUMMON_FORCE_OAUTH_ROUTING;
	try {
		if (value === undefined) delete process.env.SUMMON_FORCE_OAUTH_ROUTING;
		else process.env.SUMMON_FORCE_OAUTH_ROUTING = value;
		return fn();
	} finally {
		if (saved === undefined) delete process.env.SUMMON_FORCE_OAUTH_ROUTING;
		else process.env.SUMMON_FORCE_OAUTH_ROUTING = saved;
	}
}

function withApiKey<T>(value: string | undefined, fn: () => T): T {
	const saved = process.env.ANTHROPIC_API_KEY;
	try {
		if (value === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = value;
		return fn();
	} finally {
		if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = saved;
	}
}

test("forceOAuthRouting parses truthy opt-in values and defaults off", () => {
	assert.equal(forceOAuthRouting({}), false);
	for (const v of ["1", "true", "YES", " on "])
		assert.equal(forceOAuthRouting({ SUMMON_FORCE_OAUTH_ROUTING: v }), true);
	for (const v of ["0", "false", "", "no"]) assert.equal(forceOAuthRouting({ SUMMON_FORCE_OAUTH_ROUTING: v }), false);
});

test("spawnEnv preserves ANTHROPIC_API_KEY by default (BYO key) and sets harness env", () => {
	withApiKey("sk-byo-key", () =>
		withForceOAuth(undefined, () => {
			const env = spawnEnv("/work/repo", [".env", "secrets"]);
			assert.equal(env.ANTHROPIC_API_KEY, "sk-byo-key", "default policy must not strip the user's API key");
			assert.equal(env.HARNESS_ROOT, "/work/repo");
			assert.deepEqual(JSON.parse(env.HARNESS_PROTECTED ?? "null"), [".env", "secrets"]);
		}),
	);
});

test("spawnEnv ejects ANTHROPIC_API_KEY only when SUMMON_FORCE_OAUTH_ROUTING is set", () => {
	withApiKey("sk-should-be-ejected", () =>
		withForceOAuth("1", () => {
			const env = spawnEnv("/work/repo");
			assert.equal(env.ANTHROPIC_API_KEY, undefined, "forced OAuth must eject the key to force $0 routing");
		}),
	);
});

test("assertSpawnAuth requires a non-empty system prompt regardless of policy", () => {
	assert.throws(() => assertSpawnAuth({}, ""), /empty --system-prompt/);
	assert.throws(() => assertSpawnAuth({}, "   "), /empty --system-prompt/);
	assert.doesNotThrow(() => assertSpawnAuth({}, SYS_HEADER));
});

test("assertSpawnAuth allows an API key by default but fails closed when OAuth is forced", () => {
	// Default policy (BYO key): a present key is fine.
	assert.doesNotThrow(() => assertSpawnAuth({ ANTHROPIC_API_KEY: "sk-x" }, SYS_HEADER));
	// Forced OAuth: a surviving key must fail closed.
	assert.throws(
		() => assertSpawnAuth({ ANTHROPIC_API_KEY: "sk-x", SUMMON_FORCE_OAUTH_ROUTING: "1" }, SYS_HEADER),
		/ANTHROPIC_API_KEY is present/,
	);
	assert.doesNotThrow(() => assertSpawnAuth({ SUMMON_FORCE_OAUTH_ROUTING: "1" }, SYS_HEADER));
});

// ── window-aware governor ──────────────────────────────────────────────────────

test("estimateTokens approximates ~4 chars/token and never goes negative", () => {
	assert.equal(estimateTokens(0), 0);
	assert.equal(estimateTokens(-5), 0);
	assert.equal(estimateTokens(4), 1);
	assert.equal(estimateTokens(5), 2);
});

test("WindowGovernor.admit caps simultaneous WEIGHT and releases", async () => {
	const gov = new WindowGovernor({ maxWeight: 4 });
	const fast: AgentBundle = { ...base, model_tier: "fast" }; // weight 1
	const frontier: AgentBundle = { ...base, model_tier: "frontier" }; // weight 4
	// frontier fills the whole budget; a concurrent fast admit must block until release.
	const relFrontier = await gov.admit(frontier);
	assert.equal(gov.loadPct(), 100);
	let admitted = false;
	const pending = gov.admit(fast).then((r) => {
		admitted = true;
		return r;
	});
	await new Promise((r) => setTimeout(r, 250));
	assert.equal(admitted, false, "fast admit must queue while the frontier holds the full budget");
	relFrontier();
	const relFast = await pending;
	assert.equal(admitted, true);
	relFast();
	assert.equal(gov.loadPct(), 0);
});

test("WindowGovernor tracks token consumption inside the rolling window and prunes old usage", () => {
	const gov = new WindowGovernor({ budgetTokens: 1000, windowMs: 1000 });
	const now = 10_000;
	gov.record(400, now);
	assert.equal(gov.consumed(now), 400);
	assert.equal(gov.windowPct(now), 40);
	// usage older than windowMs ages out
	gov.record(600, now);
	assert.equal(gov.windowPct(now), 100);
	assert.equal(gov.consumed(now + 2000), 0, "all usage should have aged out of the window");
	assert.equal(gov.windowPct(now + 2000), 0);
});

test("WindowGovernor with no budget reports 0% (tracking only, never hard-gates)", () => {
	const gov = new WindowGovernor({ maxWeight: 8 });
	gov.record(1_000_000);
	assert.equal(gov.windowPct(), 0, "no budget => no window gate, surfaced as 0%");
});

test("WindowGovernor hard-gates admit when the token budget is exhausted", async () => {
	const gov = new WindowGovernor({ maxWeight: 8, budgetTokens: 100, windowMs: 60_000 });
	gov.record(100); // exhaust the window budget
	let admitted = false;
	gov.admit({ ...base, model_tier: "fast" }).then(() => {
		admitted = true;
	});
	await new Promise((r) => setTimeout(r, 250));
	assert.equal(admitted, false, "admit must queue while the window budget is exhausted");
});

// ── registry index + digest ─────────────────────────────────────────────────────

function indexReg(): Map<string, AgentBundle> {
	return new Map<string, AgentBundle>([
		[
			"scout",
			{
				name: "scout",
				role: "recon",
				model_tier: "fast",
				tools: ["read", "grep"],
				output_contract: { required_sections: ["## findings"] },
			},
		],
		[
			"builder",
			{
				name: "builder",
				role: "implement",
				model_tier: "standard",
				tools: ["read", "edit"],
				output_contract: { required_sections: ["## change-summary"] },
			},
		],
		[
			"orchestrator",
			{
				name: "orchestrator",
				role: "delegate",
				model_tier: "frontier",
				tools: ["spawn_agent"],
				may_spawn: true,
				output_contract: { required_sections: ["## delegated"] },
			},
		],
	]);
}

test("registryIndex is sorted, content-hashed, and includes role", () => {
	const idx = registryIndex(indexReg());
	assert.equal(idx.count, 3);
	assert.deepEqual(
		idx.agents.map((a) => a.name),
		["builder", "orchestrator", "scout"],
	);
	assert.equal(idx.agents.find((a) => a.name === "scout")!.role, "recon");
	assert.match(idx.hash, /^[0-9a-f]{16}$/);
	// hash is stable across calls (content-addressed; does not include generated_at)
	assert.equal(registryIndex(indexReg()).hash, idx.hash);
});

test("registryDigest is compact and can exclude the orchestrator", () => {
	const d = registryDigest(indexReg(), { exclude: ["orchestrator"] });
	assert.ok(!d.includes("orchestrator"), "orchestrator excluded");
	assert.ok(d.includes("scout[fast; tools:read/grep; ->## findings]"), `digest shape: ${d}`);
	assert.ok(d.includes("builder[standard;"), `digest has builder: ${d}`);
});

// ── persistent expertise (#7) ─────────────────────────────────────────────────────

test("parseExpertiseNote extracts the ## expertise section (or empty)", () => {
	assert.equal(parseExpertiseNote("## findings\nx\n## expertise\n- lesson A\n- lesson B"), "- lesson A\n- lesson B");
	assert.equal(parseExpertiseNote("## findings\nno note here"), "");
});

test("appendExpertiseNote creates the file, dedups, and caps entries", () => {
	const dir = join(tmpdir(), `harness-exp-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const b: AgentBundle = { ...base, name: "scout", expertise: true, _dir: dir };
	try {
		assert.equal(appendExpertiseNote(b, "lesson one"), true, "first note writes");
		assert.equal(appendExpertiseNote(b, "lesson one"), false, "identical note is deduped");
		assert.equal(appendExpertiseNote(b, ""), false, "empty note is ignored");
		assert.equal(appendExpertiseNote(b, "lesson two"), true);
		// cap to last 1 entry => only the newest survives
		appendExpertiseNote(b, "lesson three", { maxEntries: 1 });
		const body = readFileSync(join(dir, "expertise.md"), "utf8");
		assert.ok(body.includes("lesson three"), "newest kept");
		assert.ok(!body.includes("lesson one"), "oldest capped out");
		// memory loads back into the prompt only when expertise is enabled
		assert.ok(loadExpertiseMemory(b).includes("Prior expertise"));
		assert.equal(loadExpertiseMemory({ ...b, expertise: false }), "", "disabled => no memory injected");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildSystemPrompt invites a ## expertise note only when the bundle opts in", () => {
	const off = buildSystemPrompt({ ...base, expertise: false });
	assert.ok(!off.includes("## expertise"));
	const on = buildSystemPrompt({ ...base, expertise: true });
	assert.ok(on.includes("## expertise"), "opt-in bundles get the expertise instruction");
});

test("writeRegistryIndex writes once and is idempotent by content hash", () => {
	const dir = join(tmpdir(), `harness-idx-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "nested", "registry-index.json");
	try {
		const first = writeRegistryIndex(indexReg(), path);
		assert.equal(first.written, true, "first write happens");
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(onDisk.count, 3);
		assert.equal(onDisk.hash, first.hash);
		// same content => no rewrite
		assert.equal(writeRegistryIndex(indexReg(), path).written, false, "unchanged registry must not rewrite");
		// changed registry => rewrite
		const reg2 = indexReg();
		reg2.delete("scout");
		assert.equal(writeRegistryIndex(reg2, path).written, true, "changed registry must rewrite");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
