// Warm-pool transport for spawn_agent. One persistent WarmPool<RpcWorker> per bundle name,
// keyed by name. poolFor() is lazy — creating a WarmPool spawns nothing; workers are
// created on first acquire()/warm(). Lives here (not in core.ts) to keep the import graph
// acyclic: rpc-worker.ts already imports core.ts, so core must NOT import rpc-worker.ts.
//
// Dependency direction: core ← pool ← rpc-worker ← pool-transport ← extension
//                                                                   ↑ only the extension
//                                                                     imports this module
import { type AgentBundle, finalizeResult, MODEL, retryPrompt, type SpawnResult, withRetry } from "./core.ts";
import { WarmPool } from "./pool.ts";
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
			await pool.warm(opts.size ?? POOL_SIZE);
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
		p = new WarmPool<RpcWorker>(
			{ create: () => RpcWorker.start(bundle, { root: opts.root, protected: opts.protected }) },
			{ size: POOL_SIZE },
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
		const r = await w.run(prompt, (bundle.timeout_s ?? 600) * 1000);
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
}

/** Test seam — number of registered pools (drained pools are removed). */
export function _poolCount(): number {
	return POOLS.size;
}
