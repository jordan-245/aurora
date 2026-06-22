// agentTimeoutMs — per-agent SIGKILL deadline + the SUMMON_AGENT_TIMEOUT_S runtime floor.
// node --experimental-strip-types --test test/agent-timeout.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTimeoutMs } from "../src/core.ts";

test("agentTimeoutMs: uses the agent's timeout_s, defaulting to 600s", () => {
	assert.equal(agentTimeoutMs({ timeout_s: 300 }, {}), 300_000);
	assert.equal(agentTimeoutMs({}, {}), 600_000);
});

test("agentTimeoutMs: SUMMON_AGENT_TIMEOUT_S raises the floor but never shortens a longer agent", () => {
	assert.equal(
		agentTimeoutMs({ timeout_s: 300 }, { SUMMON_AGENT_TIMEOUT_S: "900" }),
		900_000,
		"short agent lifted to the floor",
	);
	assert.equal(
		agentTimeoutMs({ timeout_s: 1800 }, { SUMMON_AGENT_TIMEOUT_S: "900" }),
		1_800_000,
		"already-longer agent keeps its own timeout",
	);
});

test("agentTimeoutMs: a non-positive / non-numeric floor is ignored", () => {
	for (const v of ["0", "-5", "", "abc", undefined]) {
		assert.equal(
			agentTimeoutMs({ timeout_s: 300 }, { SUMMON_AGENT_TIMEOUT_S: v as string | undefined }),
			300_000,
			`floor '${v}' ignored`,
		);
	}
});
