import type { Component } from "@earendil-works/pi-tui";

/**
 * A Component whose lines are produced by a function on every render.
 *
 * Use it when framed/boxed content must stay LIVE — e.g. the branded startup session card, whose
 * model, thinking level and git branch can change after launch (the branch in particular loads
 * asynchronously). A static {@link Text} would snapshot stale values; this re-runs `produce` each
 * frame so the card always reflects current state.
 *
 * `produce` receives the inner (content) width the parent allotted and must keep each returned line
 * within it — callers typically `truncateToWidth(line, width)` so a framing box can never break.
 */
export class FunctionalLines implements Component {
	private readonly produce: (width: number) => string[];

	constructor(produce: (width: number) => string[]) {
		this.produce = produce;
	}

	render(width: number): string[] {
		return this.produce(width);
	}

	invalidate(): void {}
}
