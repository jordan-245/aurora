// Offline unit tests for WarmPool (pool.ts). Run:
//   node --experimental-strip-types --test test/pool.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type PooledWorker, WarmPool, type WorkerFactory } from "../src/pool.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeWorker implements PooledWorker {
	readonly id: string;
	_healthy = true;
	failReset = false;
	resets = 0;
	destroyed = false;

	constructor(id: string) {
		this.id = id;
	}
	healthy(): boolean {
		return this._healthy;
	}
	async reset(): Promise<void> {
		if (this.failReset) throw new Error("reset failed");
		this.resets++;
	}
	destroy(): void {
		this.destroyed = true;
	}
}

class FakeFactory implements WorkerFactory<FakeWorker> {
	creations = 0;
	workers: FakeWorker[] = [];

	async create(): Promise<FakeWorker> {
		this.creations++;
		const w = new FakeWorker(`w${this.creations}`);
		this.workers.push(w);
		return w;
	}
}

/** Let microtasks AND a macro-task tick drain — ensures async .then() chains settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ── Tests ────────────────────────────────────────────────────────────────────

test("acquire creates up to size, then reuses idle on release", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 2 });

	const a = await pool.acquire();
	const b = await pool.acquire();
	assert.equal(factory.creations, 2, "two workers created");

	await pool.release(a); // a → idle; reset called once
	const creationsBefore = factory.creations;

	const c = await pool.acquire(); // should pop a from idle
	assert.equal(c, a, "should reuse idle worker a");
	assert.equal(factory.creations, creationsBefore, "no new creation on reuse");
	assert.equal(a.resets, 1, "reset called exactly once on a");

	const s = pool.stats();
	assert.equal(s.idle, 0, "no idle after reacquiring a");
	assert.equal(s.busy, 2, "a(=c) and b are busy");
	assert.equal(s.total, 2, "total = idle + busy");

	// quiet linter — b is intentionally held
	void b;
});

test("acquire blocks when full and resolves on release", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 1 });

	const w1 = await pool.acquire();
	assert.equal(factory.creations, 1);

	// 2nd acquire: pool is full → queued
	let resolved = false;
	const p2 = pool.acquire();
	p2.then(() => {
		resolved = true;
	});

	await Promise.resolve(); // flush any pending microtasks
	assert.equal(resolved, false, "2nd acquire must be pending while pool is full");

	// release w1 → waiter picks it up (reused after reset)
	await pool.release(w1);
	await tick(); // let the .then() callback run

	assert.equal(resolved, true, "2nd acquire should have resolved after release");
	const w2 = await p2;
	assert.equal(w2, w1, "released worker is reused by the waiter");
	assert.equal(w1.resets, 1, "reset called once on w1");
});

test("unhealthy idle worker is dropped on acquire", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 2 });

	const a = await pool.acquire();
	await pool.release(a); // a parks as idle
	a._healthy = false; // flip unhealthy while idle

	assert.equal(factory.creations, 1);
	const c = await pool.acquire(); // must not return a
	assert.notEqual(c, a, "unhealthy idle worker must not be returned");
	assert.ok(a.destroyed, "unhealthy idle worker must be destroyed");
	assert.equal(factory.creations, 2, "a fresh worker is created instead");
});

test("release of an unhealthy worker destroys it and still serves a queued waiter", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 1 });

	const w1 = await pool.acquire();
	const p2 = pool.acquire(); // queued — pool is full
	await Promise.resolve(); // ensure the waiter is registered

	w1._healthy = false;
	await pool.release(w1); // w1 destroyed → fulfilOrIdle → creates replacement
	await tick(); // let factory.create() + resolution propagate

	const w2 = await p2;
	assert.notEqual(w2, w1, "waiter receives a replacement, not the destroyed worker");
	assert.ok(w1.destroyed, "w1 must be destroyed on unhealthy release");
	assert.equal(factory.creations, 2, "one original + one replacement");
});

test("release whose reset rejects drops the worker", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 1 });

	const w1 = await pool.acquire();
	w1.failReset = true;

	await pool.release(w1); // reset throws → w1 destroyed, not parked
	assert.ok(w1.destroyed, "w1 must be destroyed when reset fails");
	assert.equal(pool.stats().idle, 0, "no idle worker after failed reset");

	// pool is now empty; next acquire must create a fresh worker
	const w2 = await pool.acquire();
	assert.notEqual(w2, w1, "fresh worker returned after failed-reset drop");
	assert.equal(factory.creations, 2, "original + replacement");
});

test("warm pre-creates up to size", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 3 });

	await pool.warm(); // default n = size = 3
	assert.equal(factory.creations, 3, "3 workers created by warm");
	const s = pool.stats();
	assert.equal(s.idle, 3, "all pre-created workers are idle");
	assert.equal(s.busy, 0, "none busy yet");
	assert.equal(s.total, 3, "total = idle");
});

test("drain destroys all workers and zeroes stats", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 3 });

	await pool.warm(2); // 2 idle workers
	await pool.acquire(); // move one to busy: idle=1, busy=1, total=2

	assert.equal(factory.creations, 2);
	await pool.drain();

	const s = pool.stats();
	assert.equal(s.idle, 0, "no idle after drain");
	assert.equal(s.busy, 0, "no busy after drain");
	assert.equal(s.total, 0, "total is zero after drain");

	const destroyed = factory.workers.filter((w) => w.destroyed).length;
	assert.equal(destroyed, factory.creations, "every created worker is destroyed by drain");
});

// ── Elastic band (min/max/target + reapIdle) ───────────────────────────────────

/** A clock you can advance by hand, injected via the `now` ctor option. */
class FakeClock {
	t = 0;
	now = (): number => this.t;
	advance(ms: number): void {
		this.t += ms;
	}
}

test("default {size:N} keeps min=max=target=N — behavior identical", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { size: 3 });

	const s = pool.stats();
	assert.equal(s.min, 3, "min collapses to size");
	assert.equal(s.max, 3, "max collapses to size");
	assert.equal(s.target, 3, "target collapses to size");
	assert.equal(s.waiting, 0, "no waiters yet");

	// grows only to size, then queues (pre-elastic semantics)
	await pool.acquire();
	await pool.acquire();
	await pool.acquire();
	assert.equal(factory.creations, 3, "grew to size=3");
	let resolved = false;
	pool.acquire().then(() => {
		resolved = true;
	});
	await tick();
	assert.equal(resolved, false, "4th acquire queues — does not exceed size");
	assert.equal(factory.creations, 3, "no creation beyond size");
	assert.equal(pool.stats().waiting, 1, "one waiter queued");
});

test("setTarget grows ceiling lazily on acquire", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { min: 0, max: 5, target: 1 });

	const a = await pool.acquire();
	assert.equal(factory.creations, 1, "first acquire grows to target=1");

	// at target=1, a second acquire (no waiter pressure yet from caller) queues rather than grows…
	// but raising target lets the next acquire grow lazily without any eager spawn.
	pool.setTarget(3);
	assert.equal(factory.creations, 1, "setTarget does not eagerly spawn");

	const b = await pool.acquire();
	const c = await pool.acquire();
	assert.equal(factory.creations, 3, "acquires now grow up to the new target=3");

	const s = pool.stats();
	assert.equal(s.target, 3, "target updated");
	assert.equal(s.busy, 3);
	void a;
	void b;
	void c;
});

test("acquire pressure grows beyond target up to max", async () => {
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { min: 0, max: 4, target: 1 });

	// Fire concurrent acquires: the first grows to target, the rest queue as waiters which raises
	// the ceiling to max — so those queued acquires get fresh workers up to max=4.
	const ps = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
	const ws = await Promise.all(ps);
	assert.equal(factory.creations, 4, "pressure grew the pool to max=4");
	assert.equal(new Set(ws).size, 4, "four distinct workers handed out");

	// A 5th concurrent acquire must queue — cannot exceed max.
	let resolved = false;
	pool.acquire().then(() => {
		resolved = true;
	});
	await tick();
	assert.equal(resolved, false, "5th acquire queues at max");
	assert.equal(factory.creations, 4, "never exceeds max");
});

test("reapIdle destroys idle workers older than ttl above min", async () => {
	const clock = new FakeClock();
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { min: 1, max: 5, target: 5, now: clock.now });

	await pool.warm(4); // 4 idle, all stamped at t=0? no — warm() does not stamp; release does.
	// Move all 4 through acquire→release so they get idle stamps at the current clock.
	const ws = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
	for (const w of ws) await pool.release(w); // 4 idle, stamped at t=0
	assert.equal(pool.stats().idle, 4);

	clock.advance(1000);
	const reaped = await pool.reapIdle(clock.now(), 500); // ttl=500, all 4 are 1000ms old
	assert.equal(reaped, 3, "reaps down to min=1 (keeps one)");
	assert.equal(pool.stats().idle, 1, "one idle retained at min");
	const destroyed = factory.workers.filter((w) => w.destroyed).length;
	assert.equal(destroyed, 3, "exactly three workers destroyed");
});

test("reapIdle never reaps busy workers", async () => {
	const clock = new FakeClock();
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { min: 0, max: 5, target: 5, now: clock.now });

	const busy = await pool.acquire(); // busy, never idle-stamped
	const idle = await pool.acquire();
	await pool.release(idle); // idle stamped at t=0

	clock.advance(10_000);
	const reaped = await pool.reapIdle(clock.now(), 0); // ttl=0 → reap any idle ≥0ms old
	assert.equal(reaped, 1, "only the idle worker is reaped");
	assert.ok(!busy.destroyed, "busy worker must never be destroyed by reaper");
	assert.equal(pool.stats().busy, 1, "busy count unchanged");
	void busy;
});

test("scale-to-zero: min=0 reaps all idle, then a fresh acquire cold-starts", async () => {
	const clock = new FakeClock();
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { min: 0, max: 3, target: 3, now: clock.now });

	const ws = await Promise.all([pool.acquire(), pool.acquire()]);
	for (const w of ws) await pool.release(w); // 2 idle stamped at t=0
	assert.equal(pool.stats().idle, 2);

	clock.advance(100);
	const reaped = await pool.reapIdle(clock.now(), 50);
	assert.equal(reaped, 2, "min=0 ⇒ every idle worker reaped");
	assert.equal(pool.stats().total, 0, "pool scaled to zero");

	const creationsBefore = factory.creations;
	const fresh = await pool.acquire();
	assert.equal(factory.creations, creationsBefore + 1, "fresh acquire cold-starts a new worker");
	assert.ok(!fresh.destroyed);
});

test("reapIdle respects ttl — recently-used idle not reaped", async () => {
	const clock = new FakeClock();
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { min: 0, max: 5, target: 5, now: clock.now });

	// Acquire two distinct workers concurrently (held busy together), then release at different
	// times so each gets its own idle stamp — otherwise the pool would just reuse the one idle worker.
	const [old, recent] = await Promise.all([pool.acquire(), pool.acquire()]);
	await pool.release(old); // stamped at t=0

	clock.advance(900);
	await pool.release(recent); // stamped at t=900

	clock.advance(200); // now=1100: old idle 1100ms, recent idle 200ms
	const reaped = await pool.reapIdle(clock.now(), 1000); // ttl=1000
	assert.equal(reaped, 1, "only the stale worker is reaped");
	assert.ok(old.destroyed, "stale idle worker reaped");
	assert.ok(!recent.destroyed, "recently-used idle worker survives the ttl check");
});

test("reapIdle is a no-op while draining", async () => {
	const clock = new FakeClock();
	const factory = new FakeFactory();
	const pool = new WarmPool(factory, { min: 0, max: 3, target: 3, now: clock.now });

	const ws = await Promise.all([pool.acquire(), pool.acquire()]);
	for (const w of ws) await pool.release(w);
	await pool.drain(); // sets draining = true and destroys everything

	clock.advance(10_000);
	const reaped = await pool.reapIdle(clock.now(), 0);
	assert.equal(reaped, 0, "reapIdle short-circuits while draining");
});
