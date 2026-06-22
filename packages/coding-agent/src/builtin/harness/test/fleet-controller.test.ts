// Offline unit tests for FleetController (fleet-controller.ts) — pure helpers + the DI control loop,
// driven with injected signals/stats/now and spy callbacks. No real pools, subprocesses, or timers.
// Run: node --experimental-strip-types --test test/fleet-controller.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBundle, WindowGovernor } from "../src/core.ts";
import { MODEL } from "../src/core.ts";
import {
	type ControllerTick,
	computeTarget,
	type DemandLike,
	degradeTier,
	FleetController,
	type FleetControllerOpts,
	type PoolStatLike,
	routeTransport,
} from "../src/fleet-controller.ts";

// ── Fakes / builders ──────────────────────────────────────────────────────────

const demand = (over: Partial<DemandLike> & { bundle: string }): DemandLike => ({
	inflight: 0,
	queued: 0,
	arrivalRate1m: 0,
	arrivalRateTrend: 0,
	...over,
});

const bundle = (name: string, tier: AgentBundle["model_tier"] = "standard"): AgentBundle => ({
	name,
	role: "test role",
	model_tier: tier,
	tools: [],
	output_contract: { required_sections: ["## result"] },
});

const fakeGov = (pct: number): WindowGovernor => ({ windowPct: () => pct }) as unknown as WindowGovernor;

// A fully-spied opts bag: signals/poolStats are mutable so a test can drive successive ticks.
interface Harness {
	opts: FleetControllerOpts;
	setCalls: Array<{ name: string; n: number }>;
	reapCalls: Array<{ name: string; maxIdle: number }>;
	prewarmed: AgentBundle[];
	ticks: ControllerTick[][];
	demand: Map<string, DemandLike>;
	stats: PoolStatLike[];
}

const makeHarness = (over: Partial<FleetControllerOpts> = {}): Harness => {
	const h: Harness = {
		setCalls: [],
		reapCalls: [],
		prewarmed: [],
		ticks: [],
		demand: new Map(),
		stats: [],
		opts: undefined as unknown as FleetControllerOpts,
	};
	h.opts = {
		gov: fakeGov(0),
		registry: new Map(),
		signals: () => h.demand,
		poolStats: () => h.stats,
		setPoolTarget: (name, n) => {
			h.setCalls.push({ name, n });
			return true;
		},
		reapPool: (name, maxIdle) => {
			h.reapCalls.push({ name, maxIdle });
			return 0;
		},
		prewarm: async (b) => {
			h.prewarmed.push(b);
		},
		onTick: (t) => {
			h.ticks.push(t);
		},
		...over,
	};
	return h;
};

// ── computeTarget ─────────────────────────────────────────────────────────────

test("computeTarget: sums inflight + queued", () => {
	assert.equal(computeTarget(demand({ bundle: "a", inflight: 2, queued: 3 }), 0, 16), 5);
});

test("computeTarget: +1 on rising trend", () => {
	assert.equal(computeTarget(demand({ bundle: "a", inflight: 1, queued: 1, arrivalRateTrend: 0.5 }), 0, 16), 3);
	// non-positive trend adds nothing
	assert.equal(computeTarget(demand({ bundle: "a", inflight: 1, queued: 1, arrivalRateTrend: 0 }), 0, 16), 2);
	assert.equal(computeTarget(demand({ bundle: "a", inflight: 1, queued: 1, arrivalRateTrend: -1 }), 0, 16), 2);
});

test("computeTarget: clamps to max", () => {
	assert.equal(computeTarget(demand({ bundle: "a", inflight: 50, queued: 50 }), 0, 16), 16);
});

test("computeTarget: never negative", () => {
	assert.equal(computeTarget(demand({ bundle: "a", inflight: 0, queued: 0 }), 0, 16), 0);
});

// ── routeTransport ────────────────────────────────────────────────────────────

test("routeTransport: warm pool ⇒ pool", () => {
	const s: PoolStatLike = { name: "a", total: 1, idle: 1, busy: 0 };
	assert.equal(routeTransport(s, null), "pool");
});

test("routeTransport: cold single task ⇒ oneshot", () => {
	assert.equal(routeTransport(null, demand({ bundle: "a", inflight: 1, queued: 0 })), "oneshot");
	assert.equal(routeTransport({ name: "a", total: 0, idle: 0, busy: 0 }, null), "oneshot");
});

test("routeTransport: cold concurrent demand (inflight+queued≥2) ⇒ pool", () => {
	assert.equal(routeTransport(null, demand({ bundle: "a", inflight: 1, queued: 1 })), "pool");
	assert.equal(routeTransport(null, demand({ bundle: "a", inflight: 0, queued: 2 })), "pool");
});

// ── degradeTier ───────────────────────────────────────────────────────────────

test("degradeTier: frontier→standard, standard→fast, fast→fast", () => {
	assert.equal(degradeTier("frontier"), "standard");
	assert.equal(degradeTier("standard"), "fast");
	assert.equal(degradeTier("fast"), "fast");
});

test("degradeTier: MODEL[degradeTier(t)] is defined for every tier (drift guard)", () => {
	for (const t of ["fast", "standard", "frontier"] as const) {
		assert.ok(MODEL[degradeTier(t)], `MODEL must resolve degraded tier of ${t}`);
	}
});

// ── observe-only vs actuate ─────────────────────────────────────────────────────

test("observe-only: actuate=false ⇒ grow tick emitted but setPoolTarget never called", () => {
	const h = makeHarness({ actuate: false });
	h.demand.set("a", demand({ bundle: "a", inflight: 3, queued: 0 }));
	const fc = new FleetController(h.opts);

	const ticks = fc.tick(1000);
	assert.equal(ticks.length, 1);
	assert.equal(ticks[0].action, "prewarm"); // current 0 → first growth is a prewarm
	assert.equal(ticks[0].target, 3);
	assert.equal(h.setCalls.length, 0, "observe-only must not mutate pools");
	assert.equal(h.reapCalls.length, 0);
	assert.equal(h.prewarmed.length, 0);
	assert.equal(h.ticks.length, 1, "onTick still fires in observe-only");
});

test("actuate: actuate=true ⇒ setPoolTarget called with the computed target", () => {
	const h = makeHarness({ actuate: true });
	// existing pool so growth is a plain 'grow' (not prewarm) and exercises setPoolTarget directly
	h.stats = [{ name: "a", total: 1, idle: 1, busy: 0 }];
	h.demand.set("a", demand({ bundle: "a", inflight: 4, queued: 0 }));
	const fc = new FleetController(h.opts);

	const ticks = fc.tick(1000);
	assert.equal(ticks[0].action, "grow");
	assert.equal(ticks[0].target, 4);
	assert.deepEqual(h.setCalls, [{ name: "a", n: 4 }]);
});

test("actuate: growth from zero prewarms then sets target", () => {
	const h = makeHarness({ actuate: true });
	const b = bundle("a");
	h.opts.registry.set("a", b);
	h.demand.set("a", demand({ bundle: "a", inflight: 2, queued: 0 }));
	const fc = new FleetController(h.opts);

	const ticks = fc.tick(1000);
	assert.equal(ticks[0].action, "prewarm");
	assert.deepEqual(h.prewarmed, [b]);
	assert.deepEqual(h.setCalls, [{ name: "a", n: 2 }]);
});

// ── hysteresis / cooldown ───────────────────────────────────────────────────────

test("hysteresis: a 2nd tick within cooldownMs does not re-actuate", () => {
	const h = makeHarness({ actuate: true, cooldownMs: 5000 });
	h.stats = [{ name: "a", total: 1, idle: 1, busy: 0 }];
	h.demand.set("a", demand({ bundle: "a", inflight: 5, queued: 0 }));
	const fc = new FleetController(h.opts);

	const t1 = fc.tick(1000);
	assert.equal(t1[0].action, "grow");
	assert.equal(h.setCalls.length, 1);

	// pool hasn't reflected the new target yet; demand still high → would grow again, but cooling.
	const t2 = fc.tick(2000); // 1s later, < 5s cooldown
	assert.equal(t2[0].action, "hold");
	assert.equal(h.setCalls.length, 1, "no re-actuation inside the cooldown window");

	// after the cooldown elapses it may actuate again
	const t3 = fc.tick(7000); // 6s after the change
	assert.equal(t3[0].action, "grow");
	assert.equal(h.setCalls.length, 2);
});

// ── cap ──────────────────────────────────────────────────────────────────────

test("cap: target never exceeds maxPerBundle", () => {
	const h = makeHarness({ actuate: true, maxPerBundle: 4 });
	h.stats = [{ name: "a", total: 1, idle: 1, busy: 0 }];
	h.demand.set("a", demand({ bundle: "a", inflight: 100, queued: 100 }));
	const fc = new FleetController(h.opts);

	const ticks = fc.tick(1000);
	assert.equal(ticks[0].target, 4);
	assert.deepEqual(h.setCalls, [{ name: "a", n: 4 }]);
});

// ── shrink reaps ───────────────────────────────────────────────────────────────

test("shrink reaps: demand drops ⇒ reapPool then setPoolTarget called", () => {
	const h = makeHarness({ actuate: true });
	h.stats = [{ name: "a", total: 6, idle: 5, busy: 1 }];
	h.demand.set("a", demand({ bundle: "a", inflight: 1, queued: 0 }));
	const fc = new FleetController(h.opts);

	const ticks = fc.tick(1000);
	assert.equal(ticks[0].action, "shrink");
	assert.equal(ticks[0].target, 1);
	assert.deepEqual(h.reapCalls, [{ name: "a", maxIdle: 1 }]);
	assert.deepEqual(h.setCalls, [{ name: "a", n: 1 }]);
});

// ── shouldShed ─────────────────────────────────────────────────────────────────

test("shouldShed: windowPct ≥ shedAtPct ⇒ {shed:true, tier:degraded}", () => {
	const h = makeHarness({ gov: fakeGov(95), shedAtPct: 90 });
	const fc = new FleetController(h.opts);
	const d = fc.shouldShed(bundle("a", "frontier"));
	assert.equal(d.shed, true);
	assert.equal(d.tier, "standard");
});

test("shouldShed: windowPct < shedAtPct ⇒ {shed:false}", () => {
	const h = makeHarness({ gov: fakeGov(50), shedAtPct: 90 });
	const fc = new FleetController(h.opts);
	const d = fc.shouldShed(bundle("a", "frontier"));
	assert.equal(d.shed, false);
	assert.equal(d.tier, undefined);
});

// ── routeTransport (instance method delegates to pure) ──────────────────────────

test("controller.routeTransport: delegates to pure routeTransport via injected signals/stats", () => {
	const h = makeHarness();
	h.stats = [{ name: "a", total: 2, idle: 1, busy: 1 }];
	const fc = new FleetController(h.opts);
	assert.equal(fc.routeTransport(bundle("a")), "pool");

	const h2 = makeHarness();
	h2.demand.set("b", demand({ bundle: "b", inflight: 0, queued: 0 }));
	const fc2 = new FleetController(h2.opts);
	assert.equal(fc2.routeTransport(bundle("b")), "oneshot");
});

// ── onAgentEvent nudge ──────────────────────────────────────────────────────────

test("onAgentEvent: 'spawned' while running triggers a tick; ignored when stopped", () => {
	const h = makeHarness();
	h.demand.set("a", demand({ bundle: "a", inflight: 1, queued: 0 }));
	const fc = new FleetController(h.opts);

	// not started → no timer → nudge is a no-op
	fc.onAgentEvent({ t: "spawned" });
	assert.equal(h.ticks.length, 0);

	fc.start();
	fc.onAgentEvent({ t: "spawned" });
	assert.equal(h.ticks.length, 1, "nudge ticks once while running");

	// non-spawn events are ignored
	fc.onAgentEvent({ t: "done" });
	assert.equal(h.ticks.length, 1);
	fc.stop();
});

// ── start / stop ────────────────────────────────────────────────────────────────

test("start/stop: start() is idempotent and timer is unref()'d; stop() nulls it", () => {
	let unrefs = 0;
	const realSetInterval = globalThis.setInterval;
	const intervals: unknown[] = [];
	// Wrap setInterval to assert .unref() is called and a second start() does not create a new timer.
	globalThis.setInterval = ((fn: () => void, ms?: number) => {
		const id = realSetInterval(fn, ms);
		id.unref = () => {
			unrefs++;
			return id;
		};
		intervals.push(id);
		return id;
	}) as typeof setInterval;
	try {
		const h = makeHarness();
		const fc = new FleetController(h.opts);

		fc.start();
		assert.equal(intervals.length, 1, "one timer created on first start");
		assert.equal(unrefs, 1, "timer was unref()'d");

		fc.start(); // idempotent — must not create a 2nd timer
		assert.equal(intervals.length, 1, "second start() is a no-op");

		fc.stop();
		// after stop, start() can arm a fresh timer again
		fc.start();
		assert.equal(intervals.length, 2);
		fc.stop();
	} finally {
		for (const id of intervals) clearInterval(id as ReturnType<typeof setInterval>);
		globalThis.setInterval = realSetInterval;
	}
});

test("stop() before start() is safe; tick() works without a running timer", () => {
	const h = makeHarness();
	h.demand.set("a", demand({ bundle: "a", inflight: 2, queued: 0 }));
	const fc = new FleetController(h.opts);
	fc.stop(); // no throw
	const ticks = fc.tick(1000);
	assert.equal(ticks.length, 1);
});
