import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("TUI off-screen change suppression", () => {
	it("does not trigger a full redraw when all changes are entirely above the viewport", async () => {
		// 10-line logical buffer in a 5-row terminal:
		//   after initial render, prevViewportTop = max(0, 10 - 5) = 5
		//   visible rows = logical lines 5–9 ("Line 5" … "Line 9")
		//   logical lines 0–4 are off-screen (above the viewport).
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const viewportBefore = terminal.getViewport();
		const redrawsBefore = tui.fullRedraws;

		// Mutate ONLY line 0 — index 0 < prevViewportTop (5): entirely off-screen.
		component.lines = ["CHANGED OFFSCREEN", ...component.lines.slice(1)];
		tui.requestRender();
		await terminal.waitForRender();

		// (a) No full redraw should have been issued for an entirely off-screen change.
		assert.strictEqual(tui.fullRedraws, redrawsBefore, "Off-screen-only change must not trigger a full redraw");

		// (b) The visible terminal output must be byte-identical to before the mutation.
		assert.deepStrictEqual(
			terminal.getViewport(),
			viewportBefore,
			"Visible viewport must be unchanged when only off-screen lines are mutated",
		);

		tui.stop();
	});

	it("still redraws when a change falls within the visible viewport", async () => {
		// Same tall-buffer setup: 10 lines, height 5 → viewport at lines 5–9.
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		// Mutate line 7 — inside the visible viewport (lines 5–9).
		component.lines = [...component.lines.slice(0, 7), "VISIBLE CHANGE", ...component.lines.slice(8)];
		tui.requestRender();
		await terminal.waitForRender();

		// The changed line must appear in the viewport.
		const viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("VISIBLE CHANGE")),
			`Viewport change not reflected — got: ${JSON.stringify(viewport)}`,
		);

		tui.stop();
	});
});
