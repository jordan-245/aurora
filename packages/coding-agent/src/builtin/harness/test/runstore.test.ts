// Offline unit tests for the run store (identity + crash/pause discovery). Run:
//   node --experimental-strip-types --test test/runstore.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyRun, listResumableRuns, makeRunId, runEventsPath, runMeta } from "../src/runstore.ts";
import { RunSession } from "../src/session.ts";

function tmpRuns(): string {
	return mkdtempSync(join(tmpdir(), "runs-"));
}

test("makeRunId is filesystem-safe, deterministic with a fixed clock, and time-suffixed", () => {
	const id = makeRunId("blueprint", "scout build/verify!", "sess A", 1234);
	assert.match(id, /^blueprint-scout-build-verify--sess-A-1234$/);
	assert.equal(makeRunId("team", "t", "s", 999), "team-t-s-999");
});

test("runMeta reads the run_started self-describing meta", () => {
	const s = RunSession.create(runEventsPath(tmpRuns(), "x"));
	s.append("run_started", { kind: "blueprint", name: "demo", vars: { a: "1" } });
	const m = runMeta(s.events());
	assert.equal(m?.kind, "blueprint");
	assert.equal(m?.name, "demo");
	assert.deepEqual(m?.vars, { a: "1" });
});

test("classifyRun: terminal done/failed → null; crashed (no finish) → crashed; paused → paused", () => {
	const dir = tmpRuns();
	// crashed: run_started + a node, no run_finished
	const c = RunSession.create(runEventsPath(dir, "c"));
	c.append("run_started", { kind: "blueprint", name: "c" });
	c.append("node_started", { node: "n1" });
	assert.equal(classifyRun("c", c.events())?.status, "crashed");
	// paused on an approval gate
	const p = RunSession.create(runEventsPath(dir, "p"));
	p.append("run_started", { kind: "blueprint", name: "p", vars: { x: "y" } });
	p.append("approval_requested", { gate: "deploy", summary: "ship" });
	p.append("run_finished", { status: "paused" });
	const pr = classifyRun("p", p.events());
	assert.equal(pr?.status, "paused");
	assert.deepEqual(pr?.awaiting, [{ gate: "deploy", summary: "ship", node: undefined }]);
	assert.deepEqual(pr?.vars, { x: "y" });
	// terminal done → null
	const d = RunSession.create(runEventsPath(dir, "d"));
	d.append("run_started", { kind: "team", name: "d" });
	d.append("run_finished", { status: "done" });
	assert.equal(classifyRun("d", d.events()), null);
	// a dir with no run_started is not a real run
	const j = RunSession.create(runEventsPath(dir, "junk"));
	j.append("node_done", { node: "n", status: "done" });
	assert.equal(classifyRun("junk", j.events()), null);
});

test("listResumableRuns surfaces crashed+paused, skips terminal, newest-first", () => {
	const dir = tmpRuns();
	const mk = (id: string, build: (s: RunSession) => void) => build(RunSession.create(runEventsPath(dir, id)));
	mk("blueprint-a-s-100", (s) => {
		s.append("run_started", { kind: "blueprint", name: "a" });
		s.append("run_finished", { status: "done" }); // terminal → excluded
	});
	mk("blueprint-b-s-200", (s) => {
		s.append("run_started", { kind: "blueprint", name: "b" });
		s.append("node_started", { node: "x" }); // crashed → included
	});
	mk("team-c-s-300", (s) => {
		s.append("run_started", { kind: "team", name: "c" });
		s.append("run_finished", { status: "paused" }); // paused → included
	});
	const r = listResumableRuns(dir);
	assert.deepEqual(
		r.map((x) => x.runId),
		["team-c-s-300", "blueprint-b-s-200"],
		"newest-first, terminal excluded",
	);
	assert.equal(r.find((x) => x.runId === "team-c-s-300")!.status, "paused");
	assert.equal(r.find((x) => x.runId === "blueprint-b-s-200")!.status, "crashed");
	assert.deepEqual(listResumableRuns(join(dir, "does-not-exist")), []);
	rmSync(dir, { recursive: true, force: true });
});
