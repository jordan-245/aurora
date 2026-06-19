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
}

// Bounded warm pool: hands out idle healthy workers, creating up to `size`, queueing when full.
export class WarmPool<W extends PooledWorker> {
	private idle: W[] = [];
	private busy = new Set<W>();
	private waiters: Array<(w: W) => void> = [];
	private size: number;
	private factory: WorkerFactory<W>;
	private draining = false;

	constructor(factory: WorkerFactory<W>, opts: { size?: number } = {}) {
		this.factory = factory;
		this.size = Math.max(1, opts.size ?? 4);
	}

	stats(): PoolStats {
		return { total: this.idle.length + this.busy.size, idle: this.idle.length, busy: this.busy.size };
	}

	// Pre-create up to n (default = size) workers so the first tasks are instant.
	async warm(n = this.size): Promise<void> {
		const target = Math.min(this.size, n);
		while (this.idle.length + this.busy.size < target) {
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
		// 2) grow up to size
		if (this.idle.length + this.busy.size < this.size) {
			const w = await this.factory.create();
			this.busy.add(w);
			return w;
		}
		// 3) full → wait for a release
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
		// hand directly to a waiter if one is queued, else park as idle
		const next = this.waiters.shift();
		if (next) {
			this.busy.add(w);
			next(w);
		} else this.idle.push(w);
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
