// Offline unit tests for the Scale Dial (#4) pure module. Run:
//   node --experimental-strip-types --test test/scale.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveScaleMode, scaleLabel, scaleParams } from "../src/scale.ts";

test("resolveScaleMode parses auto/eco/turbo/fixed:N and defaults", () => {
	assert.deepEqual(resolveScaleMode(undefined), { kind: "auto" });
	assert.deepEqual(resolveScaleMode(""), { kind: "auto" });
	assert.deepEqual(resolveScaleMode("auto"), { kind: "auto" });
	assert.deepEqual(resolveScaleMode("ECO"), { kind: "eco" }); // case-insensitive
	assert.deepEqual(resolveScaleMode("Turbo"), { kind: "turbo" });
	assert.deepEqual(resolveScaleMode("fixed:6"), { kind: "fixed", band: 6 });
	assert.deepEqual(resolveScaleMode("  fixed:6  "), { kind: "fixed", band: 6 }); // trimmed
	// Fail-safe: anything invalid -> auto.
	assert.deepEqual(resolveScaleMode("garbage"), { kind: "auto" });
	assert.deepEqual(resolveScaleMode("fixed:x"), { kind: "auto" });
	assert.deepEqual(resolveScaleMode("fixed:0"), { kind: "auto" });
	assert.deepEqual(resolveScaleMode("fixed:-2"), { kind: "auto" });
});

test("scaleParams maps modes off a base maxWeight", () => {
	const base = { maxWeight: 8 };
	assert.equal(scaleParams({ kind: "auto" }, base).maxWeight, 8);

	const eco = scaleParams({ kind: "eco" }, base);
	assert.equal(eco.maxWeight, 4);
	assert.equal(eco.poolSize, 2);

	const turbo = scaleParams({ kind: "turbo" }, base);
	assert.equal(turbo.maxWeight, 16);
	assert.equal(turbo.poolSize, 8);

	const fixed = scaleParams({ kind: "fixed", band: 3 }, base);
	assert.equal(fixed.maxWeight, 3);
	assert.equal(fixed.poolSize, 3); // clamped into 1..8

	// poolSize clamp upper bound holds for a large fixed band.
	assert.equal(scaleParams({ kind: "fixed", band: 99 }, base).poolSize, 8);

	// auto carries base poolSize/budget, with sensible defaults when absent.
	assert.equal(scaleParams({ kind: "auto" }, { maxWeight: 8 }).poolSize, 4);
	assert.equal(scaleParams({ kind: "auto" }, { maxWeight: 8 }).budgetTokens, 0);
	assert.equal(scaleParams({ kind: "auto" }, { maxWeight: 8, poolSize: 6, budgetTokens: 100 }).poolSize, 6);
	assert.equal(scaleParams({ kind: "auto" }, { maxWeight: 8, budgetTokens: 100 }).budgetTokens, 100);

	// eco floors maxWeight but never below 1.
	assert.equal(scaleParams({ kind: "eco" }, { maxWeight: 1 }).maxWeight, 1);
});

test("scaleLabel renders each mode", () => {
	assert.equal(scaleLabel({ kind: "auto" }), "auto");
	assert.equal(scaleLabel({ kind: "eco" }), "eco");
	assert.equal(scaleLabel({ kind: "turbo" }), "turbo");
	assert.equal(scaleLabel({ kind: "fixed", band: 6 }), "fixed:6");
});
