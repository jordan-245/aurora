# Aurora — full system specification

Aurora is a single branded product — one `aurora` command — made of two layers that ship together in
this one repo:

- **The engine** — the agent itself (built on the Pi coding agent, MIT; see NOTICE), white-labeled to
  `aurora`: config home `~/.aurora`, the aurora theme as the default look, and the full neon TUI
  rendering (theme abstraction, gradient wordmark banner, rounded ascii-box tool cards, bordered
  messages, a jitter-free animator, a session card).
- **The harness** — a first-party delegation runtime bundled as a **built-in extension**: the
  `spawn_agent` tool family that runs specialised, tool-restricted, model-tiered sub-agents with
  output-contract validation, deterministic verification, a window-budget governor, safety guards, a
  live multi-agent dashboard, named teams, and an optional warm worker pool. Auto-loaded with zero
  setup; sub-agents are spawned as `aurora`.

This document is the complete specification of both.

---

## Part A — The harness

### A.1 Registry (L0)
Each specialist is a config bundle in `agents/<name>/`:
- `agent.json` — `{ name, role, model_tier (fast|standard|frontier), tools[], skills?[],
  context_globs?[], output_contract{ required_sections[], forbidden?[], max_tokens? },
  max_attempts?, timeout_s?, may_spawn? }`
- `SKILL.md` — the agent's system skill (folded into its prompt).

Model tiers map to concrete models in `src/core.ts` (`MODEL`): fast→haiku, standard→sonnet,
frontier→opus (overridable — see A.9). The seed registry: **scout** (fast, read-only recon),
**builder** (standard, minimal-diff implement + self-verify), **reviewer** (fast, independent claim
verifier), **orchestrator** (frontier, delegate-only).

**Effective registry = global (`agents/`) + project-local (`<project>/.pi/agents/`)**, the latter
overriding by name. Resolved by walking up from `cwd` to the nearest `.harness.json`/`.git`.

### A.2 Fail-closed validator
Runs at load (`validateBundle`). Rejects unsafe shapes structurally:
- an orchestrator (`may_spawn`) holding `write`/`edit`/`bash` (it delegates, never executes);
- a worker holding **any** delegation tool (`spawn_agent`/`spawn_agents`/`run_team`) — no recursive
  delegation;
- a write-capable bundle scoped into a **protected path** (`DEFAULT_PROTECTED` = `.env`, `/.git/`,
  `secrets`, `credentials`, `.pem`, `.key`, `id_rsa`, `id_ed25519`; plus a project's own
  `.harness.json` `protected[]`).

### A.3 Spawn + output-contract check
`spawnAgent` builds the worker system prompt (role + skill + expertise + the contract as explicit
required sections), spawns a `pi` subprocess with `ANTHROPIC_API_KEY` ejected (forces $0 OAuth
routing through the user's Claude subscription), captures the result, and checks the output contract
(`checkContract`): every `required_section` heading must be present and no `forbidden` string may
appear. A contract miss marks the result failed.

### A.4 Window-budget governor
`spawn_agents` enforces a max concurrent weight (`max_weight`, default 8, per-project override in
`.harness.json`). Fan-out beyond the budget queues; independent tasks run concurrently up to the cap.

### A.5 Bounded retry + expertise
- `max_attempts` (default 1): on a non-`done`/contract-fail result, re-run up to N times, folding the
  prior failure back into the next prompt (shift-feedback-left), then escalate.
- `context_globs`: files matched relative to the bundle dir are read and folded into the worker's
  prompt as a bounded `## Expertise context` block.

### A.6 Transports
- `"oneshot"` (default) — a cold `pi -p` per task.
- `"pool"` — a reused warm `pi --mode rpc` worker, context reset via `new_session` between tasks
  (`src/pool.ts` + `src/rpc-worker.ts`; idle-reuse, grow-to-size, drop-unhealthy, drain).
Both apply the identical contract + deterministic-verify gating (single-sourced `finalizeResult`).
`spawn_agents` uses an **adaptive default**: same-agent batches of ≥8 tasks auto-use the pool
(benchmarked ~30–47% faster via reuse across waves; see `bench/`), else oneshot. Override per call.

### A.7 Safety (trustable headless)
- **Deterministic verify** — `verify: "<cmd>"`; the harness runs the acceptance command itself and a
  failure overrides the agent's own claim (`verify_failed`).
- **Tool-layer guard** (`extension/guard.ts`) — loaded into every write/exec-capable worker; blocks
  destructive bash and writes to protected paths or outside the project root (`escapesRoot` is
  sibling-prefix safe).
- **builder→reviewer auto-pairing** — `spawn_agent({ review: true })` runs the reviewer over the git
  diff and **fails closed** unless the reviewer APPROVEs.

### A.8 Observability, teams, scale
- **Live TUI dashboard** (`extension/observe.ts` + `src/observe.ts`) — a widget above the editor;
  `/harness-drill <agent|next|off>` expands a per-agent tool timeline; `/harness-web [port] [host]`
  serves an external HTTP+SSE dashboard (`src/web-surface.ts`; loopback by default, optional token
  auth).
- **Named teams** (`run_team`, `src/teams.ts`) — declarative recipes: sequential stages, parallel
  steps; fail-closed loader; `{{var}}` templating. Teams may invoke only worker agents.
- **Containerised workers** (`src/container-worker.ts`) — a PooledWorker over a real docker container
  for isolation (lifecycle smoke-proven).

### A.9 Configuration (all optional, env-overridable)
`HARNESS_HOME` (install root; else derived from `src/paths.ts` via `import.meta.url`),
`HARNESS_AGENTS_DIR`, `HARNESS_TEAMS_DIR`, `HARNESS_THEMES_DIR`, `PI_CODING_AGENT_DIR`,
`HARNESS_POOL_SIZE`, `HARNESS_WEB_TOKEN_FILE`. Model ids live in `MODEL` (`src/core.ts`).

---

## Part B — The aurora engine (TUI)

A soft-fork of the Pi coding agent, branch `tui-refresh-editorial`, a linear stack of TUI commits on
top of upstream. Source delta ≈ 26 files; everything below renders only on this engine — a released
`pi` paints the theme's `colors`/`vars` and **ignores** the overhaul keys, so a theme that sets them
is safe everywhere.

### B.1 Theme abstraction
A theme is JSON with `colors` + `vars` (rendered everywhere) plus OPTIONAL overhaul keys the engine
understands:
- `glyphs` — box-drawing + spinner glyphs: `boxTL boxTR boxBL boxBR boxH boxV`,
  `toolBracketOpen/Close`, spinner frames. `asciiOnly` themes force portable `+ - |` (byte-identical
  on any terminal).
- `layout` — `toolBlockStyle` (`ascii-box`|`fill`), `inputAreaStyle` (`border-fill`|…),
  `roleLabelStyle` (`smallcaps`|…), spacing primitives.
- `gradient` — a list of hex/var colour stops: the signature ribbon.
- `banner` — `{ lines[], tagline? }`: an ASCII-art wordmark.
Pure helpers on `Theme` (`signatureGradient`, `gradientAt`, `gradientText`, `bannerLines`,
`bannerWidth`, `bannerTagline`, `gradientSpinnerFrames`) are unit-guarded. Ships themes:
`editorial`, `brutalist`, `aurora`, `harness` (+ tweaked `dark`/`light`).

### B.2 Theme selection (`--theme` / `PI_THEME`)
`--theme <NAME>` (or `PI_THEME=<name>`) **activates** a theme; `--theme <PATH>` only **registers**
one. All startup `initTheme` sites honour `PI_THEME ?? settings`, and `main.ts` unifies the `--theme`
flag into `PI_THEME` so the selection survives the interactive re-init (this also fixes
`pi --theme editorial/brutalist` generally). A `pi themes` command lists resolvable themes.

### B.3 Gradient wordmark banner + breathing spinner
At startup the engine paints `banner.lines` with a **column-aligned** gradient (colours line up
vertically between rows) when it fits the terminal width, else falls back to the plain logo.
Spinner frames "breathe" — hue cycles through the same `gradient` each tick.

### B.4 Rounded ascii-box tool cards
The `ascii-box` tool block is drawn from the theme's box-drawing glyphs (not hard-coded chars), so
`aurora`'s rounded set renders `╭── tool ──╮ / │ … │ / ╰── ✓ ── 2.4s ──╯`: the tool name accented,
the completion pill semantic (success/error). `brutalist` (asciiOnly) renders the portable set.

### B.5 Bordered messages (`messageStyle: "box"`)
Chat messages render inside rounded `box-frame` borders (violet for the user, indigo for the
assistant), every line truncated to the inner width so the frame can never break (guarded by
`message-box.test.ts` at widths 40/60/80/120).

### B.6 Jitter-free rendering (the freeze invariant)
An always-on animation near the top of scrollback is a tmux jitter footgun: once the wordmark scrolls
into scrollback, a frame/keystroke changing bytes *above* the viewport straddles the viewport
boundary → the renderer falls back to a full-screen clear+repaint → flicker. Fix = **animate only
what is on-screen**:
- `TUI.topVisible` (width-independent) gates the `BannerAnimator`: scrolled off-view → it HOLDS its
  frame and emits nothing (header bytes byte-identical → can never straddle); visible → it shimmers.
- Completed tool-card timers freeze; off-screen-only changes suppress the full redraw
  (`offscreen-change-no-fullredraw.test.ts`).
Guards: `banner-animator.test.ts` (visible-advances / hidden-frozen / toggle-resumes) +
render/viewport tests.

### B.7 Hermes-style session card
The wordmark stays unboxed + animated above; live session info (model · thinking / cwd(branch) /
tool+skill counts / hint) renders in a rounded `MessageBoxFrame` card below, labelled with the theme
name. Reusable `functional-lines.ts` re-renders the body each frame so model/branch stay live; every
line truncated to inner width (frame can never break).

---

## Part C — How they fit (the integration)

The harness is bundled as a **built-in, app-shipped extension** so it works the moment you build
Aurora — no install step, no per-user wiring.

- **Built-in resources source** (engine): the package-manager scans an app-bundled dir,
  `<app>/{src|dist}/builtin/extensions` (`config.getBuiltinExtensionsDir()`), as a lowest-precedence
  resource source. A user/project extension of the same name still wins; users can disable via
  settings. This is a general capability (first-party features ship with the app), used here for the
  harness.
- **The bundled extensions** — `src/builtin/extensions/aurora-spawn.ts` (spawn_agent / spawn_agents /
  run_team) and `aurora-observe.ts` (live dashboard + `/harness-web`) re-export the harness under
  `src/builtin/harness/`. Compiled to `dist/builtin/**` on build; agent/team data files are copied by
  `copy-assets`.
- **Sub-agent binary** — the harness spawns workers as `AGENT_BIN` (`paths.ts`, default `aurora`,
  env-overridable `AURORA_BIN`), so delegated work runs the same product.
- **Worker tool safety** — workers are spawned with a strict `--tools <allowlist>`; the engine applies
  that allowlist to **extension** tools too (`isAllowedTool` in `agent-session`), so a sub-agent never
  sees `spawn_agent` even though the built-in registers it. The validator (load-time, fail-closed) is
  the second layer.
- **Theme** — `aurora` and `harness` are **built-in themes** (`getBuiltinThemes`), and `aurora` is the
  default (`getDefaultTheme`). Switch with `aurora themes <name>`.

### Build & verify
```bash
npm install && npm run build               # builds tui · ai · agent · coding-agent (the `aurora` CLI)
npm link                                   # `aurora` on PATH
npm run check                              # full monorepo gate (biome · tsgo · smokes)
# harness unit tests (run from source):
node --experimental-strip-types --test packages/coding-agent/src/builtin/harness/test/*.test.ts
```

### Provenance & licence
Aurora is a derivative work of [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) (the Pi
coding agent, MIT © Mario Zechner) — full engine source and history retained under MIT. The Pi credit
lives in `NOTICE` + `LICENSE`; everything else is branded Aurora. Aurora adds no API key: it drives
your own authenticated login over OAuth.
