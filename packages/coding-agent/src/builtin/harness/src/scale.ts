// Scale Dial (#4): a tiny, pure, self-contained module that maps a "scale mode"
// (auto/eco/turbo/fixed:N) onto concrete fleet parameters. No harness imports.
//
// Token math note: budgetTokens is an APPROXIMATE token budget. The rough rule of
// thumb is ~4 chars/token, so callers can translate a byte/char budget into tokens
// by dividing by ~4. This module only carries the number through; it does no I/O.

export type ScaleMode = { kind: "auto" } | { kind: "eco" } | { kind: "turbo" } | { kind: "fixed"; band: number };

// Parse HARNESS_SCALE-style input. undefined/""/garbage -> {kind:"auto"} (fail-safe).
// Case-insensitive: "auto"|"eco"|"turbo"; "fixed:N" -> {kind:"fixed", band:N}
// (N a positive integer; invalid N falls back to auto).
export function resolveScaleMode(raw?: string): ScaleMode {
	if (raw === undefined) return { kind: "auto" };
	const s = raw.trim().toLowerCase();
	if (s === "" || s === "auto") return { kind: "auto" };
	if (s === "eco") return { kind: "eco" };
	if (s === "turbo") return { kind: "turbo" };
	if (s.startsWith("fixed:")) {
		const rest = s.slice("fixed:".length);
		// Only accept a plain positive integer (no signs, decimals, or extra chars).
		if (/^\d+$/.test(rest)) {
			const band = Number.parseInt(rest, 10);
			if (Number.isInteger(band) && band >= 1) return { kind: "fixed", band };
		}
		return { kind: "auto" };
	}
	return { kind: "auto" };
}

export interface FleetParams {
	maxWeight: number;
	poolSize: number;
	budgetTokens: number;
}

// Default pool size used when a base does not specify one.
const DEFAULT_POOL_SIZE = 4;
// Upper bound on pool size for eco/turbo/fixed clamping.
const MAX_POOL_SIZE = 8;

// Map a mode to fleet params off a base.
// auto   -> base (maxWeight from base; poolSize from base.poolSize ?? sensible default; budgetTokens from base.budgetTokens ?? 0).
// eco    -> { maxWeight: max(1, floor(base.maxWeight/2)), poolSize: 2, budgetTokens: base.budgetTokens ?? 0 }.
// turbo  -> { maxWeight: base.maxWeight*2, poolSize: 8, budgetTokens: 0 }.
// fixed:N-> { maxWeight: N, poolSize: clamp(N, 1..8), budgetTokens: 0 }.
export function scaleParams(
	mode: ScaleMode,
	base: { maxWeight: number; budgetTokens?: number; poolSize?: number },
): FleetParams {
	const baseBudget = base.budgetTokens ?? 0;
	switch (mode.kind) {
		case "auto":
			return {
				maxWeight: base.maxWeight,
				poolSize: base.poolSize ?? DEFAULT_POOL_SIZE,
				budgetTokens: baseBudget,
			};
		case "eco":
			return {
				maxWeight: Math.max(1, Math.floor(base.maxWeight / 2)),
				poolSize: 2,
				budgetTokens: baseBudget,
			};
		case "turbo":
			return {
				maxWeight: base.maxWeight * 2,
				poolSize: MAX_POOL_SIZE,
				budgetTokens: 0,
			};
		case "fixed":
			return {
				maxWeight: mode.band,
				poolSize: Math.min(Math.max(mode.band, 1), MAX_POOL_SIZE),
				budgetTokens: 0,
			};
	}
}

// A short human label for the gauge / notify line, e.g. "auto", "eco", "turbo", "fixed:6".
export function scaleLabel(mode: ScaleMode): string {
	switch (mode.kind) {
		case "auto":
			return "auto";
		case "eco":
			return "eco";
		case "turbo":
			return "turbo";
		case "fixed":
			return `fixed:${mode.band}`;
	}
}
