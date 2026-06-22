// Warm-pool transport for spawn_agent. One persistent WarmPool<RpcWorker> per bundle name,
// keyed by name. poolFor() is lazy — creating a WarmPool spawns nothing; workers are
// created on first acquire()/warm(). Lives here (not in core.ts) to keep the import graph
// acyclic: rpc-worker.ts already imports core.ts, so core must NOT import rpc-worker.ts.
//
// Dependency direction: core ← pool ← rpc-worker ← pool-transport ← extension
//                                                                   ↑ only the extension
//                                                                     imports this module
import {
	type AgentBundle,
	agentTimeoutMs,
	finalizeResult,
	MODEL,
	retryPrompt,
	type SpawnResult,
	withRetry,
} from "./core.ts";
import { type PoolStats, WarmPool } from "./pool.ts";
import { RpcWorker } from "./rpc-worker.ts";

export interface PoolOpts {
	runDir?: string;
	taskId?: string;
	verify?: string;
	root?: string;
	protected?: string[];
	/** Accepted but not forwarded — rpc transport streams events via its own subscriber model. */
	onEvent?: (ev: any) => void;
}

// Module-level registry: one warm pool per bundle name, created lazily on first poolFor() call.
const POOLS = new Map<string, WarmPool<RpcWorker>>();
const POOL_SIZE = Math.max(1, Number(process.env.HARNESS_POOL_SIZE ?? 4));

// Runtime band override (#4 scale dial). null ⇒ the env-derived band below. setPoolBand() installs one
// and retunes every live pool so /harness-scale takes effect immediately, not just for pools created
// after the dial moved.
let BAND_OVERRIDE: { min: number; max: number } | null = null;

// Elastic band. HARNESS_POOL_SIZE remains the default for both min and max so an unset env is identical
// to the pre-elastic fixed pool; HARNESS_POOL_MIN/MAX widen the band when set. A runtime override (the
// scale dial) wins over the env so the live band is single-sourced through this one function.
export const poolBand = (): { min: number; max: number } => {
	if (BAND_OVERRIDE) return BAND_OVERRIDE;
	const cap = Math.max(1, Number(process.env.HARNESS_POOL_SIZE ?? 4));
	const max = Math.max(1, Number(process.env.HARNESS_POOL_MAX ?? cap));
	const min = Math.max(0, Math.min(Number(process.env.HARNESS_POOL_MIN ?? cap), max));
	return { min, max };
};

// Retune the live pool band at runtime (the scale dial). Clamps min ≤ max, installs the override so
// future pools inherit it, and re-bands every existing pool. Returns the applied band.
export function setPoolBand(min: number, max: number): { min: number; max: number } {
	const hi = Math.max(1, Math.floor(max));
	const lo = Math.max(0, Math.min(Math.floor(min), hi));
	BAND_OVERRIDE = { min: lo, max: hi };
	for (const p of POOLS.values()) p.setBand(lo, hi);
	return BAND_OVERRIDE;
}

// Bundles whose pool has been PRE-WARMED (standing idle rpc workers, cold-start tax pre-paid).
// Once a bundle is pre-warmed the adaptive batch threshold no longer applies — the pool wins at any
// batch size because the worker is already hot — so pickTransport routes ALL its spawns to the pool.
const PREWARMED = new Set<string>();
export function isPrewarmed(name: string): boolean {
	return PREWARMED.has(name);
}

// Benchmark (bench/THRESHOLD-SWEEP-2026-06-17.txt): with pool size 4, the warm pool LOSES at a
// same-bundle batch of 4 (no reuse) and WINS (~30-47% faster) at ≥8 (reuse across waves). So the
// adaptive default engages the pool only when a batch has ≥ POOL_MIN_BATCH tasks of the SAME bundle.
export const POOL_MIN_BATCH = 8;

// Pure: pick a transport for one task in a batch. An explicit override always wins; otherwise route to
// the pool when the bundle is pre-warmed (hot worker already standing) OR there are ≥POOL_MIN_BATCH
// tasks of this task's own bundle in the batch (cold-start amortises across the wave).
export function pickTransport(sameBundleCount: number, override?: string, prewarmed = false): "oneshot" | "pool" {
	if (override === "pool" || override === "oneshot") return override;
	return prewarmed || sameBundleCount >= POOL_MIN_BATCH ? "pool" : "oneshot";
}

// Pre-warm: stand up `n` (default POOL_SIZE) idle rpc workers per bundle so the first spawns are
// instant (Stripe's "hot-and-ready" devbox model, at the process level). Best-effort per bundle — a
// failure to warm one bundle un-marks it but never throws. Returns a per-bundle stats summary.
export async function prewarm(
	bundles: AgentBundle[],
	opts: { root?: string; protected?: string[]; size?: number } = {},
): Promise<Array<{ name: string; total: number; idle: number; error?: string }>> {
	const out: Array<{ name: string; total: number; idle: number; error?: string }> = [];
	for (const b of bundles) {
		const pool = poolFor(b, { root: opts.root, protected: opts.protected });
		try {
			const warmed = opts.size ?? POOL_SIZE;
			await pool.warm(warmed);
			// Raise target to the warmed count so prewarmed workers sit at/below target (not reapable).
			pool.setTarget(warmed);
			PREWARMED.add(b.name);
			const s = pool.stats();
			out.push({ name: b.name, total: s.total, idle: s.idle });
		} catch (e) {
			PREWARMED.delete(b.name);
			out.push({ name: b.name, total: 0, idle: 0, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}

/**
 * Return the warm pool for `bundle`, creating one if not yet registered.
 * LAZY: constructing the WarmPool spawns nothing — workers are spawned by acquire()/warm().
 * Opts (root/protected) configure newly-created workers; cached pools ignore them.
 */
export function poolFor(bundle: AgentBundle, opts: PoolOpts = {}): WarmPool<RpcWorker> {
	let p = POOLS.get(bundle.name);
	if (!p) {
		const band = poolBand();
		p = new WarmPool<RpcWorker>(
			{ create: () => RpcWorker.start(bundle, { root: opts.root, protected: opts.protected }) },
			// Start target at min — the pool grows on demand (acquire pressure) up to max.
			{ min: band.min, max: band.max, target: band.min },
		);
		POOLS.set(bundle.name, p);
	}
	return p;
}

/** Run a single prompt on a pooled worker; release back after completion. */
async function poolRun(bundle: AgentBundle, prompt: string, opts: PoolOpts): Promise<SpawnResult> {
	const t0 = Date.now();
	const model = MODEL[bundle.model_tier];
	const pool = poolFor(bundle, opts);
	const w = await pool.acquire();
	try {
		const r = await w.run(prompt, agentTimeoutMs(bundle));
		return finalizeResult(bundle, r.text, r.ok ? 0 : 1, opts, t0, model);
	} finally {
		await pool.release(w); // reset() = new_session → clean context for the next task
	}
}

/**
 * Same retry semantics as the oneshot spawnAgent, but each attempt runs on a warm pooled
 * rpc worker. The pool is created lazily on first call; warm workers are reused across tasks.
 */
export function spawnViaPool(bundle: AgentBundle, prompt: string, opts: PoolOpts = {}): Promise<SpawnResult> {
	return withRetry(bundle.max_attempts ?? 1, (attempt, prev) =>
		poolRun(bundle, attempt === 1 ? prompt : retryPrompt(prompt, prev), opts),
	);
}

/** Drain + clear all pools (call on session_shutdown so no orphaned summon --mode rpc procs remain). */
export async function drainAllPools(): Promise<void> {
	for (const p of POOLS.values()) await p.drain();
	POOLS.clear();
	PREWARMED.clear();
	BAND_OVERRIDE = null; // reset the runtime scale-dial band so a fresh session starts from env
}

// ── Autoscaler control seams ──────────────────────────────────────────────────
// These let an external controller observe pressure (poolStatsAll) and drive the band: nudge a
// pool's target up under load (setPoolTarget) and shrink idle workers back down (reapPool /
// reapAllPools). All operate over the live POOLS registry, mirroring drainAllPools' iteration.

/** Per-pool snapshot for every registered pool (name + full PoolStats: total/idle/busy/min/max/target/waiting). */
export function poolStatsAll(): Array<{ name: string } & PoolStats> {
	const out: Array<{ name: string } & PoolStats> = [];
	for (const [name, p] of POOLS) out.push({ name, ...p.stats() });
	return out;
}

/** Set one pool's target (clamped into its [min,max]). Returns false if no pool by that name. */
export function setPoolTarget(name: string, n: number): boolean {
	const p = POOLS.get(name);
	if (!p) return false;
	p.setTarget(n);
	return true;
}

/**
 * Reap one pool's idle workers idle for ≥ `ttlMs`, down to its `min`. `ttlMs=0` reaps every idle
 * worker above min immediately. Resolves to the number reaped (0 if no pool by that name).
 */
export function reapPool(name: string, ttlMs: number): Promise<number> {
	const p = POOLS.get(name);
	return p ? p.reapIdle(Date.now(), ttlMs) : Promise.resolve(0);
}

/**
 * PRECISE shrink: reap one pool's idle workers until its total ≤ `target` (the exact size the
 * autoscaler computed), oldest-idle first, never touching busy workers. Resolves to the number reaped
 * (0 if no pool by that name). This is what the controller drives on a 'shrink' decision — unlike
 * reapPool(…,0) it stops at the target instead of collapsing to min.
 */
export function reapToTarget(name: string, target: number): Promise<number> {
	const p = POOLS.get(name);
	return p ? p.reapToTarget(target) : Promise.resolve(0);
}

/** Reap idle workers older than `ttlMs` across every pool. Returns the per-pool reaped counts. */
export function reapAllPools(now: number, ttlMs: number): Promise<number[]> {
	return Promise.all([...POOLS.values()].map((p) => p.reapIdle(now, ttlMs)));
}

/** Test seam — number of registered pools (drained pools are removed). */
export function _poolCount(): number {
	return POOLS.size;
}
