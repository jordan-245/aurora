// ContainerWorker — a PooledWorker backed by a real long-lived Docker container.
//
// HONEST SCOPE: This delivers the container-ISOLATION primitive (one isolated docker container
// per pooled worker — the Stripe devbox model). Running the summon agent INSIDE the container is
// the remaining step and is intentionally OUT OF SCOPE here: it needs a prepared image with
// the summon CLI + Claude OAuth baked in. This module + smoke prove the container lifecycle pools
// correctly with a real container (busybox).
//
// Usage:
//   const worker = await ContainerWorker.start({ image: "busybox:latest" });
//   const pool = new WarmPool({ create: () => ContainerWorker.start() }, { size: 4 });

import { spawnSync } from "node:child_process";
import type { PooledWorker } from "./pool.ts";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

// ── ContainerWorker ───────────────────────────────────────────────────────

export class ContainerWorker implements PooledWorker {
	readonly id: string;
	private alive = true;

	private cid: string;
	private image: string;
	private workdir: string;

	private constructor(cid: string, image: string, workdir: string) {
		this.cid = cid;
		this.image = image;
		this.workdir = workdir;
		// Stable id derived from first 12 hex chars of the container id.
		this.id = `container-${cid.slice(0, 12)}`;
	}

	// ── Factory ──────────────────────────────────────────────────────────────

	/**
	 * Spin up a long-lived idle container labelled `harness-worker` so the
	 * finally-sweep in the smoke script can find and kill any leaked containers.
	 * The container sits idle on `tail -f /dev/null` until destroyed.
	 */
	static async start(opts: { image?: string; workdir?: string } = {}): Promise<ContainerWorker> {
		const image = opts.image ?? "busybox:latest";
		const workdir = opts.workdir ?? "/work";

		const r = spawnSync(
			"docker",
			["run", "-d", "--label", "harness-worker", image, "sh", "-c", `mkdir -p ${workdir}; tail -f /dev/null`],
			{ encoding: "utf8" },
		);

		if (r.status !== 0) {
			throw new Error(`docker run failed: ${(r.stderr || r.stdout).trim()}`);
		}

		const cid = r.stdout.trim();
		if (!cid) throw new Error("docker run returned empty container id");

		return new ContainerWorker(cid, image, workdir);
	}

	// ── Core API ──────────────────────────────────────────────────────────────

	/** Run a shell command inside the container synchronously. */
	exec(cmd: string): ExecResult {
		const r = spawnSync("docker", ["exec", this.cid, "sh", "-c", cmd], { encoding: "utf8" });
		return {
			ok: r.status === 0,
			stdout: (r.stdout ?? "").trim(),
			stderr: (r.stderr ?? "").trim(),
		};
	}

	// ── PooledWorker interface ─────────────────────────────────────────────

	/**
	 * true iff the container is alive and in Running state.
	 * Called by WarmPool before handing the worker to the next task.
	 */
	healthy(): boolean {
		if (!this.alive) return false;
		const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", this.cid], { encoding: "utf8" });
		return r.status === 0 && r.stdout.trim() === "true";
	}

	/**
	 * Clear the scratch workdir so the next pooled task gets a clean slate.
	 * The trailing `true` keeps the exit code 0 even if globbing finds nothing.
	 * Called by WarmPool.release() between tasks.
	 */
	async reset(): Promise<void> {
		// Two-pass: explicit glob + hidden files; `true` guards an empty match.
		this.exec(`rm -rf ${this.workdir}/* ${this.workdir}/.[!.]* 2>/dev/null; mkdir -p ${this.workdir}; true`);
	}

	/**
	 * Force-remove the container. After this the worker must not be used again.
	 * Called by WarmPool.drain() or when healthy() → false.
	 */
	destroy(): void {
		this.alive = false;
		spawnSync("docker", ["rm", "-f", this.cid], { encoding: "utf8" });
	}
}
