// Offline unit tests for the durable run session (event log, derive-state, resume, approvals). Run:
//   node --experimental-strip-types --test test/session.test.ts

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blueprintResume, deriveState, pendingApprovals, RunSession, readEvents } from "../src/session.ts";

function tmp(): string {
	return join(mkdtempSync(join(tmpdir(), "sess-")), "run.jsonl");
}

test("append assigns monotonic seq and persists as JSONL replayable across reopen", () => {
	const p = tmp();
	const s = RunSession.create(p);
	s.append("run_started", { kind: "blueprint", name: "demo" });
	s.append("node_started", { node: "a" });
	s.append("node_done", { node: "a", status: "done", output_excerpt: "hi" });
	const ev = readEvents(p);
	assert.equal(ev.length, 3);
	assert.deepEqual(
		ev.map((e) => e.seq),
		[1, 2, 3],
	);
	// resume continues the seq (wake(sessionId))
	const s2 = RunSession.resume(p);
	const next = s2.append("run_finished", { status: "done" });
	assert.equal(next.seq, 4);
	assert.equal(readEvents(p).length, 4);
	rmSync(p.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
});

test("readEvents tolerates a torn final line (crash mid-write)", () => {
	const p = tmp();
	const s = RunSession.create(p);
	s.append("run_started", { kind: "fanout" });
	// simulate a half-written final line by appending raw junk
	appendFileSync(p, '{"seq":2,"type":"node_started"');
	const ev = readEvents(p);
	assert.equal(ev.length, 1); // the torn line is skipped, the rest replays
	rmSync(p.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
});

test("deriveState reduces node outcomes + latest approval decision", () => {
	const s = RunSession.create(tmp());
	s.append("node_done", { node: "a", status: "done", output_excerpt: "A" });
	s.append("node_skipped", { node: "b", skipped_by: ["a"] });
	s.append("approval_requested", { gate: "deploy" });
	s.append("approval_decided", { gate: "deploy", approved: true });
	const st = deriveState(s.events());
	assert.equal(st.nodes.get("a"), "done");
	assert.equal(st.nodes.get("b"), "skipped");
	assert.equal(st.outputs.get("a"), "A");
	assert.equal(st.approvals.get("deploy"), "approved");
});

test("blueprintResume splits done vs failed/skipped and surfaces approved/denied gates", () => {
	const s = RunSession.create(tmp());
	s.append("node_done", { node: "ok", status: "done", output_excerpt: "out" });
	s.append("node_done", { node: "bad", status: "failed" });
	s.append("node_skipped", { node: "sk", skipped_by: ["bad"] });
	s.append("approval_decided", { gate: "g1", approved: true });
	s.append("approval_decided", { gate: "g2", approved: false });
	const r = blueprintResume(s.events());
	assert.deepEqual([...r.done], ["ok"]);
	assert.deepEqual([...r.failedOrSkipped].sort(), ["bad", "sk"]);
	assert.equal(r.output.get("ok"), "out");
	assert.ok(r.approved.has("g1"));
	assert.ok(r.denied.has("g2"));
});

test("pendingApprovals lists requested-but-undecided gates only", () => {
	const s = RunSession.create(tmp());
	s.append("approval_requested", { gate: "g1", summary: "ship it", node: "deploy" });
	s.append("approval_requested", { gate: "g2", summary: "rm cache" });
	s.append("approval_decided", { gate: "g1", approved: true });
	const pend = pendingApprovals(s.events());
	assert.equal(pend.length, 1);
	assert.equal(pend[0].gate, "g2");
	assert.equal(pend[0].summary, "rm cache");
});
