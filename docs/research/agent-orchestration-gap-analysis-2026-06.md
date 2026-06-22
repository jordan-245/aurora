# Summon vs. the 2026 state of the art in agent loops & orchestration

**Date:** 2026-06-21 · **Method:** Brave Search API + direct page fetches of primary sources
(Anthropic Engineering, Claude docs, LangGraph/OpenAI/Temporal docs, Arize/mem0/Letta), cross-checked
against Summon's actual source (`/root/summon`, SPEC.md identical to `/root/aurora`).

> Scope note: findings below are grounded in real fetched pages (URLs in **Sources**). Where I state a
> Summon gap, it is checked against `packages/coding-agent/src/builtin/harness/**` and the package docs,
> not assumed.

---

## 1. The current frontier (what "latest practice" now means)

**A. Anthropic's own stack has moved from "build an agent" → "build a meta-harness."**
- *Building Effective Agents* (the canonical baseline): prefer **simple, composable patterns** over
  frameworks; workflow patterns = prompt-chaining, routing, parallelisation, **orchestrator-worker**,
  **evaluator-optimizer**; use the autonomous agent loop only when you need open-ended iteration.
- *Effective context engineering*: the discipline is now **context engineering**, not prompt
  engineering. Core idea: **context rot / attention budget** — find the *smallest set of high-signal
  tokens*. Levers: just-in-time retrieval (agentic search over pre-fetched chunks), **compaction**,
  **structured note-taking / memory files**, and **sub-agent context isolation**.
- *Effective harnesses for long-running agents*: the **initializer-agent + coding-agent** pattern — a
  special first-context-window prompt sets up `init.sh`, a `claude-progress.txt` log, a JSON **feature
  list** (tests marked failing), and a git commit; every later session makes **incremental** progress
  and leaves a **clean, mergeable state**. Compaction alone is *not* enough for multi-window work.
- *Scaling Managed Agents* (Apr 2026 — the newest, most important piece): **decouple brain / hands /
  session.** The **session is a durable, append-only event log that lives OUTSIDE the context window**;
  the **harness is "cattle"** (crash → `wake(sessionId)` + `getSession` + resume from last event); the
  **sandbox is "cattle"** (`provision()` / `execute(name,input)→string`, a dead container is just a
  tool-call error handed back to Claude). `getEvents()` lets the brain *interrogate* context (slice,
  rewind, reread) rather than make irreversible compaction cuts. **Credentials never reachable from the
  sandbox** (MCP proxy + vault). "Many brains, many hands"; dropped p50 TTFT ~60%.
- *Multi-agent research system*: orchestrator-worker, lead saves its **plan to memory** (200K
  truncation insurance), spawns subagents in parallel, **separate CitationAgent pass**. Hard numbers:
  **multi-agent (Opus lead + Sonnet workers) beat single-Opus by 90.2%**; **token usage alone explains
  80% of eval variance**; multi-agent burns **~15× chat tokens**. Prompt levers: **teach the
  orchestrator how to delegate** (every subtask needs objective + output format + tool guidance + clear
  boundaries), and **scale effort to query complexity** (1 agent/3-10 calls simple → 10+ subagents
  complex). Multi-agent is a **bad fit** when agents must share context / have many dependencies (most
  coding).
- *Agent Skills* (open standard since Dec 2025): portable `SKILL.md` capability bundles across
  Claude.ai / Code / API. *Writing tools for agents*: token-efficient, non-overlapping, evaluation-
  driven tool design.

**B. The framework field converged on a clean three-layer split** (LangChain's own framing):
- **framework** (model/tool/loop abstractions) — LangChain, Pydantic AI, OpenAI Agents SDK
- **orchestration runtime** (durable execution, persistence, HITL, streaming) — **LangGraph**, Temporal
- **harness** (planning + subagents + filesystem + context mgmt) — Deep Agents, Claude Code, Summon

  Distinctive features now considered table-stakes per layer:
  - **LangGraph**: durable execution + **checkpointers/persistence**, **human-in-the-loop (inspect &
    modify state at any point)**, **time-travel**, streaming, short+long-term memory, LangSmith tracing.
  - **OpenAI Agents SDK**: **handoffs** (control transfer within one run), **guardrails** (input/output/
    **tool** guardrails), **sessions** (serialize + **resume the same run from state** for async HITL),
    built-in tracing.
  - **Temporal / durable execution**: workflows survive crashes & resume *exactly* where they left off,
    state held for years. (Sharp critique making the rounds: LangGraph checkpointers persist *between*
    nodes, **not inside a long-running node/loop** — so a crash mid-tool-loop loses in-node state.)
  - **Memory** is its own product category now: **Letta/MemGPT** (LLM-as-OS: main context + recall/
    archival, self-editing memory), **mem0** (extraction-based, removed graph in v3), **LangMem**
    (procedural memory — agents rewrite their own instructions), **Zep/Graphiti** (temporal knowledge
    graphs). Benchmarks on LoCoMo.
  - **Deep-research agents**: planner + orchestrator + **evaluator-optimizer plan-verification loop**;
    RL/self-reflection variants (Kimi-Researcher); explicit citation pass.
  - **Observability/eval**: **OpenTelemetry-native tracing** (Langfuse, Arize), trace→eval→fix loops
    (LangSmith Engine auto-proposes fixes from traces), agent-trajectory evals as first-class.

---

## 2. Where Summon is already aligned (genuine strengths — don't regress these)

| SOTA practice | Summon's implementation |
|---|---|
| Orchestrator-worker pattern | `orchestrator` agent (frontier, delegate-only) + `spawn_agents` wide fan-out |
| **Sub-agent context isolation** | every worker is a separate `summon` process w/ its own window; returns only its contract sections — *exactly* Anthropic's compression rationale |
| Model tiering to cost | fast/standard/frontier → haiku/sonnet/opus (matches Claude Code's Explore/Plan/general split) |
| Evaluator-optimizer | builder→reviewer **auto-pairing** (`review:true`, fails closed unless APPROVE) |
| Deterministic verification | `verify:"<cmd>"` — harness runs acceptance itself, overrides agent's claim |
| Tool/permission scoping per agent | strict `--tools` allowlist + fail-closed **validator** (no upward delegation, no write into protected paths) |
| Scale effort to complexity | window governor (concurrency weight) + adaptive pool transport |
| Skills standard | `SKILL.md` per bundle (compatible with the open Agent Skills format) |
| Fleet observability | cross-run `fleet.jsonl` ledger, cost/agent-hour, boot **prompt-bloat audit**, live TUI + web dashboard |
| Code-as-orchestration | **blueprints** = code-defined DAG (deterministic code nodes + scoped agent nodes) — "put the LLM in contained boxes" |
| Credential safety | `$0-OAuth canary` ejects `ANTHROPIC_API_KEY`, fails closed |

**Summon is, structurally, a credible orchestrator-worker harness.** Its differentiators (the OAuth
canary, the fail-closed validator, deterministic verify, blueprint code-nodes, the window governor) are
genuinely ahead of most OSS harnesses on *trustable headless execution*.

---

## 3. The gaps (prioritised) — where the frontier has moved past Summon

### 🔴 Gap 1 — No durable session / resumable orchestration ("the harness is a pet")
- **SOTA:** Managed Agents makes harness & sandbox *cattle*: a durable append-only **session log lives
  outside the context window**; crash → `wake(sessionId)` resume from last event. LangGraph/Temporal/
  OpenAI-SDK all center on **persistence + resume-from-state**.
- **Summon:** `packages/agent/docs/durable-harness.md` describes a *semi-durable* target, but the **harness
  orchestration layer (`builtin/harness/src/**`) has no checkpoint/resume/persist** (grep confirms none).
  If the orchestrator process dies mid-DAG, the whole fan-out is lost; there is no event log of the run
  to resume from. `fleet.jsonl` is an *after-the-fact* ledger, not a resumable state tree.
- **Why it matters:** this is now *the* defining property of a production agent runtime, and the single
  biggest structural gap. Long/expensive fan-outs (15× token cost!) with no resume is a real liability.

### 🔴 Gap 2 — No human-in-the-loop / approval interrupts
- **SOTA:** LangGraph "inspect & modify state at any point"; OpenAI SDK guardrails + **approvals that
  pause and resume the same run**; Anthropic's whole "cap the blast radius" theme.
- **Summon:** no approval/interrupt primitive in the harness (grep: none). Workers run to completion;
  the only human gate is *after* a result via the reviewer. No "pause here, ask the human, resume."
- **Why it matters:** trustable headless still needs a *pause-and-confirm* seam for risky actions
  (exactly the gate you invoked in this very session). Today Summon can only block via tool-guard or
  fail a verify — it can't *ask*.

### 🟡 Gap 3 — Context management is single-layer (inherited Pi compaction only)
- **SOTA (Arize benchmarked your own engine):** **Pi** = basic LLM compaction (token threshold,
  `keepRecentTokens`, tool-pair safety). **OpenClaw** adds *on top of Pi*: history-share trigger,
  **staged multi-pass summarization**, a **pre-compaction memory flush** (silent turn persists state to
  files before history is dropped), and **non-destructive tool-result pruning** (soft-trim → hard-clear
  on a TTL). **Claude Code** adds harness-first read gating: byte gate + token gate + line defaults +
  **file-read dedup** + remote-tunable feature flags, compaction ~167K.
- **Summon:** inherits Pi's single compaction layer; **no pre-compaction flush, no tool-result pruning,
  no read-dedup/byte-gating at the harness layer** (Summon's cache dedups *sub-tasks*, not *file reads*).
- **Why it matters:** "context rot" is the dominant failure mode; the orchestrator and long-lived
  workers will degrade on big jobs without the multi-layer treatment competitors ship.

### 🟡 Gap 4 — Orchestrator is fire-and-synthesize, not iterative/adaptive
- **SOTA:** the research lead **re-plans mid-run** ("decides whether more research is needed → spawns
  additional subagents or refines strategy"), persists its plan to memory, and runs a **separate
  citation/synthesis pass**. Deep-research uses an explicit **plan→verify→re-plan** evaluator-optimizer.
- **Summon:** the orchestrator SKILL is a single pass: decompose → fan-out → await → synthesize. It can
  spawn a reviewer on a failed node, but there's **no first-class re-plan loop**, no plan-persisted-to-
  memory, no dedicated citation/grounding pass. Blueprints are *static* DAGs (great determinism, but no
  dynamic expansion based on intermediate findings).
- **Why it matters:** breadth-first/open-ended tasks (the exact case multi-agent wins 90%) need dynamic
  spawning driven by intermediate results, not a frozen up-front DAG.

### 🟡 Gap 5 — No long-term / cross-session memory (only per-bundle `expertise.md`)
- **SOTA:** Letta self-editing memory, mem0 extraction, LangMem **procedural memory (agents rewrite
  their own instructions)**, temporal knowledge graphs. Memory is a product layer.
- **Summon:** `expertise.md` per bundle (capped ~4KB, append-on-success) is a *nice* lightweight
  procedural-memory seed — but there's **no shared/long-term memory store, no semantic retrieval, no
  cross-agent knowledge sharing.** Each run is largely amnesiac beyond that file.
- **Why it matters:** repeated work (Boris Cherny's "routines": CI fixes, PR babysitting, rebasing)
  compounds value only with memory that persists and is retrievable.

### 🟢 Gap 6 — No built-in eval / scoring / trajectory grading
- **SOTA:** evaluator-optimizer as a pattern; LangSmith/Arize/Langfuse trace→eval→fix loops; "think like
  your agent" simulation harnesses; OpenTelemetry-native traces.
- **Summon:** has deterministic `verify` (great for code) + reviewer (subjective), but **no eval
  harness, no LLM-judge/rubric scoring, no trajectory regression suite, no OTel export.** Observability
  is fleet *accounting*, not *quality* measurement.
- **Why it matters:** you can't improve delegation prompts without measuring sub-agent quality over a
  fixed task set; Anthropic explicitly calls prompt-iteration-on-evals their primary lever.

### 🟢 Gap 7 — No standard tool/integration plane (MCP) at the harness layer
- **SOTA:** MCP is the de-facto tool standard; Managed Agents routes external tools via an **MCP proxy +
  credential vault** so the agent never holds tokens.
- **Summon:** workers get a fixed `--tools` allowlist of built-ins. No first-class MCP server wiring for
  workers, no credential-vault/proxy pattern (it relies on OAuth-only + tool-guard).
- **Why it matters:** real tasks need Slack/GitHub/Drive/etc.; without an MCP plane Summon's workers are
  capped at local file/bash work.

### 🟢 Gap 8 — Static sandbox isolation, not "many hands"
- **SOTA:** brain decoupled from *many* swappable sandboxes (`execute(name,input)→string`), provisioned
  on demand, dead sandbox = tool error.
- **Summon:** has a `container-worker` (docker isolation, "smoke-proven") but it's a single
  per-worker isolation mode, not a brain-routes-to-many-hands abstraction with on-demand provisioning.

---

## 4. Recommendations (structural, prioritised)

1. **Durable run session (Gap 1) — highest leverage.** Promote the `durable-harness.md` design into the
   harness: an append-only **run event log** (`runs/<id>/events.jsonl`) recording every spawn/result/
   DAG-edge, with `resumeRun(id)` that replays completed nodes and re-fires only `ready` ones. This
   directly hardens the 15×-token fan-outs and unlocks Gaps 2 & 4.
2. **Approval/interrupt seam (Gap 2).** A `requires_approval` flag on a bundle/blueprint node that
   **pauses the run, surfaces to the human (TUI/web), and resumes from the event log**. Reuses Gap-1
   machinery. (You manually re-implemented this gate in-conversation today — make it a primitive.)
3. **Iterative orchestrator (Gap 4).** Add a re-plan loop to the orchestrator SKILL: persist the plan to
   a run-memory file, allow "spawn more / refine" after a synthesis check, and add a dedicated
   **grounding/citation pass** agent for research-type goals. Let blueprints declare *dynamic* fan-out
   nodes (spawn-N-from-prior-output).
4. **Context layer-up (Gap 3).** Adopt OpenClaw-style **pre-compaction memory flush** + **non-destructive
   tool-result pruning** for the orchestrator and long-lived pooled workers; add **file-read dedup/
   byte-gating** at the harness tool layer (Claude Code pattern).
5. **Eval harness (Gap 6).** A `summon eval` over a fixed task set producing trajectory + contract +
   verify pass-rates and cost, with optional LLM-judge rubric — so delegation prompts can be tuned on
   data. Add **OpenTelemetry export** from the fleet ledger for Langfuse/Arize.
6. **MCP plane (Gap 7)** and **memory store (Gap 5)** as follow-ons: per-bundle MCP server allowlist +
   token vault/proxy; a retrievable cross-run memory beyond `expertise.md`.

**One-line takeaway:** Summon is a strong *stateless, trust-first orchestrator-worker harness* — ahead
on safety (OAuth canary, fail-closed validator, deterministic verify, code-node blueprints). The
frontier has moved to **durable, resumable, human-interruptible, memory-bearing** runtimes with
**multi-layer context management** and **eval-driven** iteration. Closing Gaps 1, 2, and 4 (all built on
one durable-session spine) would move Summon from "great fan-out tool" to "production agent runtime."

---

## Sources (fetched/searched 2026-06-21)
- Anthropic — Building Effective Agents: https://www.anthropic.com/research/building-effective-agents
- Anthropic — Effective context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic — Effective harnesses for long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic — Scaling Managed Agents (decouple brain/hands): https://www.anthropic.com/engineering/managed-agents
- Anthropic — How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic — Building agents with the Claude Agent SDK: https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk
- Anthropic — Writing tools for AI agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic — Equipping agents with Agent Skills (open standard): https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Claude docs — How the agent loop works (turns/budgets/stopping): https://code.claude.com/docs/en/agent-sdk/agent-loop
- Claude docs — Subagents: https://platform.claude.com/docs/en/agent-sdk/subagents
- LangGraph overview (framework/runtime/harness split, durable execution, HITL): https://docs.langchain.com/oss/python/langgraph/overview
- OpenAI Agents SDK — handoffs / guardrails / sessions: https://openai.github.io/openai-agents-python/handoffs/ , /guardrails/
- Temporal — Durable Execution for AI agents: https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai
- Arize — Context management in agent harnesses (Pi vs OpenClaw vs Claude Code vs Letta): https://arize.com/blog/context-management-in-agent-harnesses/
- mem0 — State of AI Agent Memory 2026: https://mem0.ai/blog/state-of-ai-agent-memory-2026
- Letta: https://github.com/letta-ai/letta
- Deep Research Agents survey (arXiv 2506.18096): https://arxiv.org/abs/2506.18096
- Langfuse (OTel-native LLM observability/eval): https://langfuse.com/docs/observability/overview
