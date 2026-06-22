// Fleet controller — the harness autoscaler's PURE control loop (Idea 3 PR1). Decides per-bundle
// pool targets from observed demand, decides oneshot-vs-pool routing, and gates spawns when the usage
// window is hot — all from INJECTED signals so it unit-tests offline with no real pools, subprocesses,
// or wall-clock timers. Defaults to OBSERVE-ONLY (actuate=false): it emits ControllerTicks but never
// mutates pools until wired up (a later PR). The ONLY codebase dependency is core.ts.

import type { AgentBundle, WindowGovernor } from "./core.ts";

// A single warm pool's occupancy snapshot (injected; the controller never reaches into a real pool).
export interface PoolStatLike {
	name: string;
	total: number;
	idle: number;
	busy: number;
}
// Observed demand for one bundle over the recent window (injected by the signals source).
export interface DemandLike {
	bundle: string;
	inflight: number;
	queued: number;
	arrivalRate1m: number;
	arrivalRateTrend: number;
}
// One scaling decision the controller made this tick (always surfaced via onTick, even in observe-only).
export interface ControllerTick {
	bundle: string;
	current: number;
	target: number;
	action: "grow" | "shrink" | "hold" | "reap" | "prewarm";
	reason: string;
}
// Whether a spawn should shed load (degrade tier) because the usage window is hot.
export interface ShedDecision {
	shed: boolean;
	tier?: AgentBundle["model_tier"];
	reason: string;
}

export interface FleetControllerOpts {
	gov: WindowGovernor;
	registry: Map<string, AgentBundle>;
	actuate?: boolean; // false = OBSERVE-ONLY (default)
	tickMs?: number; // 2000
	maxPerBundle?: number; // 16
	cooldownMs?: number; // 5000
	idleReapMs?: number; // 30000
	shedAtPct?: number; // 90
	signals: (now?: number) => Map<string, DemandLike>;
	poolStats: () => Array<PoolStatLike>;
	setPoolTarget: (name: string, n: number) => boolean;
	reapPool: (name: string, maxIdle: number) => number;
	prewarm: (b: AgentBundle) => Promise<unknown>;
	onTick: (ticks: ControllerTick[]) => void;
	now?: () => number;
}

// ── PURE helpers (top-level, individually tested) ─────────────────────────────

// Target pool size for a bundle: cover everything in flight + queued, plus one speculative slot when
// arrivals are trending up, clamped to [0, max].
export function computeTarget(d: DemandLike, _current: number, max: number): number {
	const need = d.inflight + d.queued + (d.arrivalRateTrend > 0 ? 1 : 0);
	return Math.max(0, Math.min(max, need));
}

// Route a spawn to the warm pool when a pool already exists OR demand is concurrent enough to amortize
// the pool; otherwise a one-shot subprocess is cheaper.
export function routeTransport(s: PoolStatLike | null, d: DemandLike | null): "oneshot" | "pool" {
	if (s && s.total > 0) return "pool";
	if (d && d.inflight + d.queued >= 2) return "pool";
	return "oneshot";
}

// One step down the model-tier ladder (frontier → standard → fast → fast). The fast floor never errors.
export function degradeTier(tier: AgentBundle["model_tier"]): AgentBundle["model_tier"] {
	return tier === "frontier" ? "standard" : tier === "standard" ? "fast" : "fast";
}

// Per-bundle control state the loop carries between ticks (for the cooldown/hysteresis gate).
interface BundleCtl {
	lastTarget: number;
	lastChangeAt: number;
}

export class FleetController {
	private readonly gov: WindowGovernor;
	private readonly registry: Map<string, AgentBundle>;
	private readonly actuate: boolean;
	private readonly tickMs: number;
	private maxPerBundle: number; // mutable: the scale dial (#4) can retune the per-bundle cap at runtime
	private readonly cooldownMs: number;
	private readonly idleReapMs: number;
	private readonly shedAtPct: number;
	private readonly signals: (now?: number) => Map<string, DemandLike>;
	private readonly poolStats: () => Array<PoolStatLike>;
	private readonly setPoolTarget: (name: string, n: number) => boolean;
	private readonly reapPool: (name: string, maxIdle: number) => number;
	private readonly prewarm: (b: AgentBundle) => Promise<unknown>;
	private readonly onTick: (ticks: ControllerTick[]) => void;
	private readonly now: () => number;

	private ctl = new Map<string, BundleCtl>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(opts: FleetControllerOpts) {
		this.gov = opts.gov;
		this.registry = opts.registry;
		this.actuate = opts.actuate ?? false;
		this.tickMs = opts.tickMs ?? 2000;
		this.maxPerBundle = Math.max(1, opts.maxPerBundle ?? 16);
		this.cooldownMs = opts.cooldownMs ?? 5000;
		this.idleReapMs = opts.idleReapMs ?? 30000;
		this.shedAtPct = opts.shedAtPct ?? 90;
		this.signals = opts.signals;
		this.poolStats = opts.poolStats;
		this.setPoolTarget = opts.setPoolTarget;
		this.reapPool = opts.reapPool;
		this.prewarm = opts.prewarm;
		this.onTick = opts.onTick;
		this.now = opts.now ?? (() => Date.now());
	}

	start(): void {
		if (this.timer) return;
		const t = setInterval(() => this.tick(), this.tickMs);
		t.unref?.();
		this.timer = t;
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	// Runtime scale dial (#4): retune the per-bundle pool ceiling the controller grows toward.
	setMaxPerBundle(n: number): void {
		this.maxPerBundle = Math.max(1, Math.floor(n));
	}

	// The control step: read injected signals + pool stats, decide a per-bundle target with a cooldown
	// gate, emit a ControllerTick for each, and (only when actuating) apply non-hold actions. Always
	// fires onTick so observability sees decisions even in observe-only mode.
	tick(now = this.now()): ControllerTick[] {
		const demand = this.signals(now);
		const stats = new Map(this.poolStats().map((s) => [s.name, s]));
		const ticks: ControllerTick[] = [];
		for (const [name, d] of demand) {
			const s = stats.get(name) ?? null;
			const current = s ? s.total : 0;
			let c = this.ctl.get(name);
			if (!c) {
				c = { lastTarget: current, lastChangeAt: 0 };
				this.ctl.set(name, c);
			}
			const target = computeTarget(d, current, this.maxPerBundle);
			// Only gate AFTER a real change (lastChangeAt > 0); a never-touched bundle is free to act now.
			const cooling = c.lastChangeAt > 0 && now - c.lastChangeAt < this.cooldownMs;
			let action: ControllerTick["action"];
			let reason: string;
			if (target > current) {
				if (cooling) {
					action = "hold";
					reason = `cooldown: would grow ${current}->${target}`;
				} else {
					action = current === 0 ? "prewarm" : "grow";
					reason = `demand ${d.inflight}+${d.queued} (trend ${d.arrivalRateTrend})`;
				}
			} else if (target < current) {
				if (cooling) {
					action = "hold";
					reason = `cooldown: would shrink ${current}->${target}`;
				} else {
					action = "shrink";
					reason = `demand fell to ${d.inflight}+${d.queued}`;
				}
			} else {
				action = "hold";
				reason = "at target";
			}
			ticks.push({ bundle: name, current, target, action, reason });
			if (this.actuate && action !== "hold") this.apply(name, target, action, now, c);
		}
		this.onTick(ticks);
		return ticks;
	}

	// Decide transport for an about-to-spawn agent from current pool + demand for its bundle.
	routeTransport(agent: AgentBundle): "oneshot" | "pool" {
		const s = this.poolStats().find((p) => p.name === agent.name) ?? null;
		const d = this.signals(this.now()).get(agent.name) ?? null;
		return routeTransport(s, d);
	}

	// Shed (degrade one tier) when the rolling usage window is at/above the shed threshold.
	shouldShed(b: AgentBundle): ShedDecision {
		const pct = this.gov.windowPct();
		if (pct < this.shedAtPct) return { shed: false, reason: `window ${pct}% < ${this.shedAtPct}%` };
		return {
			shed: true,
			tier: degradeTier(b.model_tier),
			reason: `window ${pct}% >= ${this.shedAtPct}% — degrade tier`,
		};
	}

	// Event-driven nudge: a fresh spawn means demand just changed, so re-run the loop immediately
	// (only while running — a stopped controller stays quiet).
	onAgentEvent(e: { t: string }): void {
		if (e.t === "spawned" && this.timer) this.tick();
	}

	private apply(name: string, target: number, action: ControllerTick["action"], now: number, c: BundleCtl): void {
		if (action === "prewarm") {
			const b = this.registry.get(name);
			if (b) void this.prewarm(b);
		}
		if (action === "shrink") this.reapPool(name, target);
		this.setPoolTarget(name, target);
		c.lastTarget = target;
		c.lastChangeAt = now;
	}
}
