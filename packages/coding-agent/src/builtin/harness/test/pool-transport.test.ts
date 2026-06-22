// Frozen offline tests for pool-transport registry logic (poolFor, drainAllPools, _poolCount).
// NO workers are spawned — WarmPool is lazy; factory.create() is never called by these tests.
// Run: node --experimental-strip-types --test test/pool-transport.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBundle } from "../src/core.ts";
import {
	_poolCount,
	drainAllPools,
	isPrewarmed,
	POOL_MIN_BATCH,
	pickTransport,
	poolBand,
	poolFor,
	poolStatsAll,
	reapAllPools,
} from "../src/pool-transport.ts";

// Minimal valid bundles — only fields required by AgentBundle.
const b1: AgentBundle = {
	name: "pool-test-a",
	role: "test role A",
	model_tier: "fast",
	tools: ["read"],
	output_contract: { required_sections: ["## x"] },
};
const b2: AgentBundle = {
	name: "pool-test-b",
	role: "test role B",
	model_tier: "fast",
	tools: ["read"],
	output_contract: { required_sections: ["## x"] },
};

test("poolFor caches one pool per bundle name", async () => {
	try {
		const p1 = poolFor(b1);
		const p2 = poolFor(b1);
		assert.strictEqual(p1, p2, "same bundle name → same WarmPool instance");
		assert.equal(_poolCount(), 1, "exactly one pool in the registry");
	} finally {
		await drainAllPools();
	}
});

test("poolFor returns distinct pools for distinct bundles", async () => {
	try {
		const pa = poolFor(b1);
		const pb = poolFor(b2);
		assert.notStrictEqual(pa, pb, "different bundle names → different WarmPool instances");
		assert.equal(_poolCount(), 2, "two pools in the registry");
	} finally {
		await drainAllPools();
	}
});

// --- pickTransport (pure, frozen) ---

test("pickTransport: sameBundleCount below threshold → oneshot", () => {
	assert.strictEqual(pickTransport(4), "oneshot");
	assert.strictEqual(pickTransport(7), "oneshot");
});

test("pickTransport: sameBundleCount at/above threshold → pool", () => {
	assert.strictEqual(pickTransport(8), "pool");
	assert.strictEqual(pickTransport(20), "pool");
});

test("pickTransport: override wins regardless of count", () => {
	assert.strictEqual(pickTransport(1, "pool"), "pool");
	assert.strictEqual(pickTransport(50, "oneshot"), "oneshot");
});

test("pickTransport: a pre-warmed bundle routes to the pool at ANY batch size", () => {
	assert.strictEqual(pickTransport(1, undefined, true), "pool", "pre-warmed single task uses the hot pool");
	assert.strictEqual(pickTransport(4, undefined, true), "pool");
	// explicit override still wins over the pre-warm preference
	assert.strictEqual(pickTransport(1, "oneshot", true), "oneshot");
	// not pre-warmed + below threshold => oneshot (unchanged behaviour)
	assert.strictEqual(pickTransport(1, undefined, false), "oneshot");
});

test("isPrewarmed defaults to false for an un-warmed bundle", () => {
	assert.strictEqual(isPrewarmed("never-warmed"), false);
});

test("POOL_MIN_BATCH calibration constant is 8", () => {
	assert.strictEqual(POOL_MIN_BATCH, 8);
});

// --- pool registry ---

test("drainAllPools clears the registry; poolFor returns a fresh pool afterwards", async () => {
	const pre = poolFor(b1);
	assert.equal(_poolCount(), 1, "one pool before drain");

	// drain is a no-op on a lazy (never-acquired) pool — no workers to destroy
	await drainAllPools();
	assert.equal(_poolCount(), 0, "registry is empty after drain");

	const post = poolFor(b1);
	assert.notStrictEqual(post, pre, "a new WarmPool is returned after drain (not the old stale one)");

	await drainAllPools(); // cleanup so tests don't leak state
});

// --- elastic band (env-driven) ---

test("poolFor with default env yields min=max from POOL_SIZE (target===min)", async () => {
	try {
		const p = poolFor(b1);
		const s = p.stats();
		// With env unset, poolBand collapses to {min:max} = HARNESS_POOL_SIZE (default 4); target starts at min.
		const band = poolBand();
		assert.equal(s.min, band.min, "min from band");
		assert.equal(s.max, band.max, "max from band");
		assert.equal(s.min, s.max, "default env ⇒ min===max (fixed band)");
		assert.equal(s.target, s.min, "target starts at min (grow on demand)");
		assert.equal(s.total, 0, "still lazy — no workers spawned");
	} finally {
		await drainAllPools();
	}
});

test("poolBand parses HARNESS_POOL_MIN/MAX overrides", () => {
	const prevSize = process.env.HARNESS_POOL_SIZE;
	const prevMin = process.env.HARNESS_POOL_MIN;
	const prevMax = process.env.HARNESS_POOL_MAX;
	try {
		process.env.HARNESS_POOL_MIN = "2";
		process.env.HARNESS_POOL_MAX = "9";
		delete process.env.HARNESS_POOL_SIZE;
		assert.deepEqual(poolBand(), { min: 2, max: 9 }, "min/max parsed from env");

		// min is clamped to never exceed max
		process.env.HARNESS_POOL_MIN = "20";
		process.env.HARNESS_POOL_MAX = "5";
		assert.deepEqual(poolBand(), { min: 5, max: 5 }, "min clamped down to max");

		// unset min/max fall back to HARNESS_POOL_SIZE for both
		delete process.env.HARNESS_POOL_MIN;
		delete process.env.HARNESS_POOL_MAX;
		process.env.HARNESS_POOL_SIZE = "6";
		assert.deepEqual(poolBand(), { min: 6, max: 6 }, "size is the default for both bounds");
	} finally {
		if (prevSize === undefined) delete process.env.HARNESS_POOL_SIZE;
		else process.env.HARNESS_POOL_SIZE = prevSize;
		if (prevMin === undefined) delete process.env.HARNESS_POOL_MIN;
		else process.env.HARNESS_POOL_MIN = prevMin;
		if (prevMax === undefined) delete process.env.HARNESS_POOL_MAX;
		else process.env.HARNESS_POOL_MAX = prevMax;
	}
});

test("poolStatsAll / reapAllPools iterate the registry", async () => {
	try {
		poolFor(b1);
		poolFor(b2);

		const stats = poolStatsAll();
		assert.equal(stats.length, 2, "one entry per registered pool");
		const names = stats.map((s) => s.name).sort();
		assert.deepEqual(names, ["pool-test-a", "pool-test-b"], "names mirror the registry");
		for (const s of stats) {
			assert.equal(s.total, 0, "lazy pools have no workers");
			assert.equal(typeof s.target, "number", "PoolStats fields present");
		}

		// reapAllPools maps each pool → reaped count; lazy pools have nothing idle to reap.
		const reaped = await reapAllPools(Date.now(), 0);
		assert.deepEqual(reaped, [0, 0], "no idle workers ⇒ zero reaped per pool");
	} finally {
		await drainAllPools();
	}
});
