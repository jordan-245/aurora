# PR plan: durable, resumable, human-interruptible run spine

**Closes gaps 1, 2, 4** from `docs/research/agent-orchestration-gap-analysis-2026-06.md`
(no durable session · no human-in-the-loop · fire-and-synthesize orchestration).

**Thesis (from Anthropic's *Scaling Managed Agents*):** make the **session a durable, append-only event
log that lives outside the context window**, so the harness/orchestration is *cattle* — a crashed or
human-paused run reboots and **resumes from the last event** instead of losing the whole fan-out. All
three gaps hang off this one spine, so it is built once and reused.

---

## Phase 1 — the spine (IMPLEMENTED in this changeset ✅)

Pure, injectable, unit-tested — same house style as `blueprint.ts` / `fleet.ts` (no Pi/subprocess deps).

### New: `src/session.ts`
- **`RunSession`** — one append-only JSONL log per run; **monotonic in-process `seq`** (concurrent
  fan-out appends never race on a read-before-write). `RunSession.create(path)` / `.resume(path)`
  (the `wake(sessionId)` path — continues the seq from the last event).
- **Event taxonomy:** `run_started · node_started · node_done · node_skipped · approval_requested ·
  approval_decided · run_finished`.
- **`readEvents`** tolerates a **torn final line** (crash mid-write) — the rest of the log still replays.
- **`deriveState`** — pure event-sourcing reducer → node outcomes, outputs, latest approval per gate.
- **`blueprintResume`** — resume view: `{ done, failedOrSkipped, output, approved, denied }`.
- **`pendingApprovals`** — gates requested-but-undecided (for a human surface).

### Changed: `src/blueprint.ts` — `runBlueprint(bp, vars, exec, opts?)` (4th arg OPTIONAL, fully back-compat)
- `opts.journal(ev)` — called as the DAG advances (`node_started` / `node_done` / `approval_requested`
  / `run_finished`), so a `RunSession` records the run durably.
- `opts.resume` — seeds already-`done` nodes (their recorded output flows downstream via
  `{{node.<id>}}`) and already-failed/skipped nodes; **completed side effects are never re-run**.
- `opts.isApproved(node)` + node field **`requires_approval`** — a gated node parks in
  `awaiting_approval` (durable pause) instead of launching; the run returns **`{ paused: true,
  awaiting: [...] }`**. Granting the gate (recorded in the journal) and re-invoking `runBlueprint`
  releases it.
- **Omitting `opts` is byte-for-byte the old behaviour** (guard test included).

### Tests (9 new; suite 148 → **157, all green**) — `test/session.test.ts`, `test/blueprint.test.ts`
seq monotonicity + reopen · torn-line tolerance · derive/resume reducers · pendingApprovals · **resume
skips completed nodes & flows their output** · **approval gate pauses then resumes** · back-compat guard.
CI-clean: `biome check` ✓, `tsgo --noEmit` ✓.

---

## Phase 2 — wire the spine into the live extension (`extension/spawn-agent.ts`)

Goal: every `run_blueprint` (then `spawn_agents`/`run_team`) writes a durable session and is resumable
from the CLI, with an approval surface. Touch-points:

1. **Run id + session path.** Add `RUNS_DIR = join(CONFIG_HOME,"harness","runs")` to `paths.ts`; a run
   id is `${blueprint}-${ctx.sessionId}-${Date.now()}` → `runs/<id>/events.jsonl`. (Replaces today's
   ephemeral `tmpdir()/harness-runs/<sessionId>` for blueprints; keep tmp for one-off spawns.)
2. **Thread the journal.** In the `run_blueprint` tool, `const sess = RunSession.create(path)` and pass
   `journal: (e)=>sess.append(e.type, e)` into `runBlueprint`. Emit `run_started` first.
3. **Resume command.** New tool `resume_run({ run_id })` (+ CLI `summon resume <run_id>`): load events
   → `blueprintResume` → re-load the blueprint → `runBlueprint(bp, vars, exec, { resume, journal,
   isApproved })`. (Persist `vars` in the `run_started` event so resume is self-contained.)
4. **Approval surface (gap 2).** A paused outcome lists `awaiting` gates; surface via the existing
   `agent-event` emitter (TUI dashboard already consumes these) and add `approve_gate({ run_id, gate,
   approved })` → appends `approval_decided` → auto-resumes. `isApproved = (n)=>resume.approved.has(n.id)`.
5. **Crash recovery on boot.** At extension load, scan `RUNS_DIR` for sessions whose last event isn't
   `run_finished:done`; surface them as resumable (one `agent-event`), don't auto-run.

**Risk control:** Phase 2 is additive — the in-memory path stays the default until the session write is
proven; a `HARNESS_DURABLE=0` escape hatch disables journaling. No change to `spawnOnce`/`finalizeResult`.

## Phase 3 — extend coverage + close gap 4

- **Fan-out + teams durability.** Give `spawn_agents` and `run_team` the same session (each task = a
  node-shaped event); resume re-fires only unfinished tasks. (Reuses `deriveState`; teams already run
  through `runOne`.)
- **Approval in `spawn_agent`.** A `requires_approval` param parks a single spawn the same way.
- **Iterative orchestrator (gap 4).** Promote the orchestrator SKILL to: persist plan to the session
  (`run_started.goal` + a `plan` event), allow a bounded **re-plan loop** (spawn-more after a synthesis
  check), and add a dedicated **citation/grounding pass** agent for research goals. Add a *dynamic*
  blueprint node (`fan_out_from: <id>`) that expands N children from an upstream node's output —
  durable because each spawned child is journaled.
- **TUI/web approval UX.** `/harness-web` (`web-surface.ts`) gains a pending-approvals panel + approve
  button posting to `approve_gate`.

---

## Why this design (vs. alternatives)
- **Event log, not a mutable snapshot:** resume after a crash is just "replay → derive → continue";
  matches Managed Agents' `getSession`/`getEvents` and avoids irreversible state loss.
- **In-process seq, not file-line-count:** wide fan-out appends concurrently — re-reading to assign seq
  would race. A `RunSession` owning the counter is race-free within the process.
- **Optional `opts`, not a new runner:** zero-risk rollout — every existing caller/test is unchanged;
  durability is opt-in per call site as it's wired.
- **Gate id = node id:** one gate per gated node keeps approval state trivially derivable and idempotent.

## Test/rollout
- Phase 1: shipped with unit tests (offline, deterministic).
- Phase 2: add an integration test that runs a blueprint, kills the process after node N (SIGKILL in a
  child), then `resume_run` and asserts nodes 1..N are not re-executed (a sentinel file counts runs).
- Rollout: land Phase 1 (inert spine) → wire `run_blueprint` behind `HARNESS_DURABLE` (default on once
  the integration test is green) → extend to fan-out/teams → orchestrator re-plan.

## Files
- `src/session.ts` (new, ~190 LoC) · `test/session.test.ts` (new)
- `src/blueprint.ts` (resume/approval/journal hooks; back-compat) · `test/blueprint.test.ts` (+3 tests)
- Phase 2/3 (not in this changeset): `extension/spawn-agent.ts`, `src/paths.ts`, `src/web-surface.ts`,
  `agents/orchestrator/SKILL.md`.
