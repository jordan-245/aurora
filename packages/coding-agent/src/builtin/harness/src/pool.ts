// Bounded warm-worker pool — generic, dependency-free. Concrete transports (e.g. an rpc-mode summon
// process) implement PooledWorker. The pool is injected with a WorkerFactory so it stays
// unit-testable offline.

// A reusable pooled worker. Concrete transports (e.g. an rpc-mode summon process) implement this.
export interface PooledWorker {
	readonly id: string;
	healthy(): boolean; // false → the pool drops it instead of reusing
	reset(): Promise<void>; // clear context so the worker can take an unrelated next task
	destroy(): void; // terminate / free the worker
}

export interface WorkerFactory<W extends PooledWorker> {
	create(): Promise<W>;
}

export interface PoolStats {
	total: number;
	idle: number;
	busy: number;
	min: number;
	max: number;
	target: number;
	waiting: number;
}

// Elastic warm pool: hands out idle healthy workers, growing under acquire pressure up to `max`
// (to `target` when no one is waiting), shrinking idle workers down to `min` via reapIdle (a TTL
// reaper an external controller drives). When min=max=target the band collapses to a fixed-size
// pool with the exact pre-elastic semantics. min=0 ⇒ scale-to-zero (all idle workers reapable).
export class WarmPool<W extends PooledWorker> {
	private idle: W[] = [];
	private busy = new Set<W>();
	private waiters: Array<(w: W) => void> = [];
	private min: number;
	private max: number;
	private target: number;
	private idleSince = new WeakMap<W, number>();
	private now: () => number;
	private factory: WorkerFactory<W>;
	private draining = false;

	constructor(
		factory: WorkerFactory<W>,
		opts: { size?: number; min?: number; max?: number; target?: number; now?: () => number } = {},
	) {
		this.factory = factory;
		// Back-compat: {size:N} alone ⇒ min=max=target=N (fixed band, pre-elastic semantics).
		const cap = Math.max(1, opts.size ?? 4);
		this.max = Math.max(1, opts.max ?? cap);
		this.min = Math.max(0, Math.min(opts.min ?? cap, this.max));
		this.target = Math.min(Math.max(opts.target ?? cap, this.min), this.max);
		this.now = opts.now ?? Date.now;
	}

	stats(): PoolStats {
		return {
			total: this.idle.length + this.busy.size,
			idle: this.idle.length,
			busy: this.busy.size,
			min: this.min,
			max: this.max,
			target: this.target,
			waiting: this.waiters.length,
		};
	}

	// Pre-create up to n (default = target) workers so the first tasks are instant. Never exceeds max.
	async warm(n = this.target): Promise<void> {
		const ceiling = Math.min(this.max, n);
		while (this.idle.length + this.busy.size < ceiling) {
			const w = await this.factory.create();
			this.idle.push(w);
		}
	}

	async acquire(): Promise<W> {
		if (this.draining) throw new Error("pool draining");
		// 1) reuse an idle, healthy worker (drop unhealthy ones)
		while (this.idle.length) {
			const w = this.idle.pop()!;
			if (w.healthy()) {
				this.busy.add(w);
				return w;
			}
			w.destroy();
		}
		// 2) grow: up to `target` normally, up to `max` while acquires are queued (pressure).
		const live = this.idle.length + this.busy.size;
		const ceiling = this.waiters.length > 0 ? this.max : this.target;
		if (live < ceiling) {
			const w = await this.factory.create();
			this.busy.add(w);
			return w;
		}
		// 3) at ceiling → wait for a release
		return new Promise<W>((resolve) => this.waiters.push(resolve));
	}

	async release(w: W): Promise<void> {
		this.busy.delete(w);
		// unhealthy → drop
		if (!w.healthy()) {
			w.destroy();
			this.fulfilOrIdle();
			return;
		}
		// reset context for reuse; if reset fails, drop it
		try {
			await w.reset();
		} catch {
			w.destroy();
			this.fulfilOrIdle();
			return;
		}
		// hand directly to a waiter if one is queued, else park as idle (stamp its idle time for the reaper)
		const next = this.waiters.shift();
		if (next) {
			this.busy.add(w);
			next(w);
		} else {
			this.idle.push(w);
			this.idleSince.set(w, this.now());
		}
	}

	// Move target into [min,max]. Lazy: no eager spawn/destroy — acquire grows and reapIdle shrinks.
	setTarget(n: number): void {
		this.target = Math.min(Math.max(Math.floor(n), this.min), this.max);
	}

	// Destroy idle workers idle for ≥ ttlMs, down to at most `min` retained. Never touches busy
	// workers; no-op while draining. Snapshot→idle mutation is fully synchronous so the JS single
	// thread serializes this against acquire (no worker can be reaped mid-handout).
	async reapIdle(now: number, ttlMs: number): Promise<number> {
		if (this.draining) return 0;
		let removable = this.idle.length + this.busy.size - Math.max(this.min, 0);
		if (removable <= 0) return 0;
		const keep: W[] = [];
		let reaped = 0;
		for (const w of this.idle) {
			const since = this.idleSince.get(w);
			if (removable > 0 && since !== undefined && now - since >= ttlMs) {
				w.destroy();
				this.idleSince.delete(w);
				removable--;
				reaped++;
			} else keep.push(w);
		}
		this.idle = keep;
		return reaped;
	}

	// After dropping a worker, a queued waiter must still be served — create a replacement.
	private fulfilOrIdle(): void {
		const next = this.waiters.shift();
		if (!next) return;
		this.factory.create().then((w) => {
			this.busy.add(w);
			next(w);
		});
	}

	async drain(): Promise<void> {
		this.draining = true;
		for (const w of this.idle) w.destroy();
		for (const w of this.busy) w.destroy();
		this.idle = [];
		this.busy.clear();
		this.waiters = [];
	}
}
