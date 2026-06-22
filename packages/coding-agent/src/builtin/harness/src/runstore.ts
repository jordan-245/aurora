// Harness v2 — run store: identity + discovery for durable run sessions (Phase 2/3).
//
// Each durable run owns a directory <RUNS_DIR>/<runId>/ with an append-only events.jsonl (a
// RunSession from session.ts). This module is the PURE glue around that layout: deterministic run
// ids, path resolution, the self-describing run-meta carried in the first event, and crash/pause
// DISCOVERY (scan the runs dir, replay each log, surface what is resumable). fs-reading but
// deterministic over a tmp dir → fully unit-testable; no Pi/subprocess deps.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blueprintResume, deriveState, pendingApprovals, type RunEvent, readEvents } from "./session.ts";

export type RunKind = "blueprint" | "fanout" | "team" | "spawn";

// Self-describing meta carried in the run_started event so resume needs nothing but the log.
export interface RunMeta {
	kind: RunKind;
	name: string; // blueprint/team name, or the agent for a single spawn
	vars?: Record<string, string>; // templating vars (blueprint/team) — replayed on resume
}

// Deterministic, filesystem-safe run id. Time-suffixed so repeated runs of the same target are
// distinct dirs; sessionId ties a run to the launching summon session for crash-recovery context.
export function makeRunId(kind: RunKind, name: string, sessionId = "session", now: number = Date.now()): string {
	const safe = (s: string) =>
		String(s)
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.slice(0, 48) || "x";
	return `${safe(kind)}-${safe(name)}-${safe(sessionId)}-${now}`;
}

export function runEventsPath(runsDir: string, runId: string): string {
	return join(runsDir, runId, "events.jsonl");
}

// The run_started event's meta (first event), or null if absent/corrupt.
export function runMeta(events: RunEvent[]): RunMeta | null {
	const e = events.find((x) => x.type === "run_started");
	if (!e) return null;
	const kind = e.kind as RunKind;
	if (!kind || typeof e.name !== "string") return null;
	return { kind, name: e.name, vars: (e.vars as Record<string, string>) ?? {} };
}

export interface ResumableRun {
	runId: string;
	kind: RunKind;
	name: string;
	status: "crashed" | "paused"; // crashed = no run_finished recorded; paused = stopped at an approval gate
	awaiting: { gate: string; summary?: string; node?: string }[];
	vars: Record<string, string>;
}

// One run's resumability from its event log. Terminal runs (run_finished: done/failed) → null.
export function classifyRun(runId: string, events: RunEvent[]): ResumableRun | null {
	const meta = runMeta(events);
	if (!meta) return null; // no run_started → not a real run dir
	const st = deriveState(events);
	if (st.runStatus === "done" || st.runStatus === "failed") return null; // terminal
	const status: ResumableRun["status"] = st.runStatus === "paused" ? "paused" : "crashed";
	return {
		runId,
		kind: meta.kind,
		name: meta.name,
		status,
		awaiting: pendingApprovals(events),
		vars: meta.vars ?? {},
	};
}

// Scan RUNS_DIR and surface every run that is resumable (crashed mid-run or paused on approval).
// Best-effort + bounded: skips unreadable dirs; newest-first.
export function listResumableRuns(runsDir: string): ResumableRun[] {
	if (!existsSync(runsDir)) return [];
	const out: ResumableRun[] = [];
	let entries: string[];
	try {
		entries = readdirSync(runsDir);
	} catch {
		return [];
	}
	for (const runId of entries) {
		const p = runEventsPath(runsDir, runId);
		if (!existsSync(p)) continue;
		const r = classifyRun(runId, readEvents(p));
		if (r) out.push(r);
	}
	// newest-first by the time suffix embedded in the run id
	return out.sort((a, b) => tsOf(b.runId) - tsOf(a.runId));
}

function tsOf(runId: string): number {
	const m = runId.match(/-(\d+)$/);
	return m ? Number(m[1]) : 0;
}

// Re-export the blueprint resume view so the extension imports one module for the durable path.
export { blueprintResume };
