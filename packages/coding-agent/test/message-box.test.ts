import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { MessageBoxFrame } from "../src/modes/interactive/components/box-frame.ts";
import { FunctionalLines } from "../src/modes/interactive/components/functional-lines.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, loadThemeFromPath, setThemeInstance } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// ============================================================================
// messageStyle: "box" — bordered chat messages (aurora)
//
// Guards the off-by-one box-padding bug CLASS: every framed line MUST be exactly
// the requested width, on both the rounded (╭╮╰╯) and the portable +/-/| glyph
// sets. The body padding is single-sourced in box-frame.wrapBoxBody, so this also
// transitively guards the tool-card frame that shares it.
// ============================================================================

const DARK_JSON = join(__dirname, "..", "src", "modes", "interactive", "theme", "dark.json");

/** Activate a temp theme = builtin dark + the given layout/glyph overrides. */
function useTheme(extra: Record<string, unknown>): void {
	const base = JSON.parse(readFileSync(DARK_JSON, "utf-8"));
	const merged = {
		...base,
		name: "test-box",
		layout: { ...(base.layout ?? {}), userRoleLabel: "you", assistantRoleLabel: "aurora", ...(extra.layout ?? {}) },
		glyphs: { ...(base.glyphs ?? {}), ...(extra.glyphs ?? {}) },
	};
	const dir = mkdtempSync(join(tmpdir(), "msg-box-"));
	const p = join(dir, "test-box.json");
	writeFileSync(p, JSON.stringify(merged));
	setThemeInstance(loadThemeFromPath(p, "truecolor"));
}

const ROUNDED_GLYPHS = { boxTL: "╭", boxTR: "╮", boxBL: "╰", boxBR: "╯", boxH: "─", boxV: "│" };

afterEach(() => {
	initTheme("dark");
});

describe("MessageBoxFrame", () => {
	test("rounded box fills every line to the exact width", () => {
		useTheme({ layout: { messageStyle: "box" }, glyphs: ROUNDED_GLYPHS });
		const body = new Container();
		body.addChild(new Text("hello world", 0, 0));
		const frame = new MessageBoxFrame(body, { label: "YOU", borderColor: "accent", labelColor: "accent" });

		for (const width of [24, 40, 60, 80]) {
			const lines = frame.render(width).map(stripAnsi);
			expect(lines.length).toBeGreaterThanOrEqual(3);
			expect(lines[0].startsWith("╭── YOU ")).toBe(true);
			expect(lines[0].endsWith("╮")).toBe(true);
			expect(lines[lines.length - 1].startsWith("╰")).toBe(true);
			expect(lines[lines.length - 1].endsWith("╯")).toBe(true);
			for (const l of lines) expect(visibleWidth(l)).toBe(width);
		}
	});

	test("branded session card pattern: FunctionalLines + truncate never breaks the frame", () => {
		// Guards the startup session card (interactive-mode): a dynamic, possibly-overlong body wrapped
		// in MessageBoxFrame must stay width-exact at every terminal width, so the rounded frame can never
		// be split by a long model id / cwd / branch. Mirrors the real construction (truncate to inner w).
		useTheme({ layout: { messageStyle: "box" }, glyphs: ROUNDED_GLYPHS });
		const longBody = [
			"model claude-opus-4-8 · xhigh   ·   ~/very/deeply/nested/working/directory/path (feature/some-very-long-branch-name)",
			"50 skills · 7 prompts · 15 extensions",
			"",
			"/ commands · ! bash · ctrl+o help & resources",
		];
		const card = new MessageBoxFrame(
			new FunctionalLines((innerWidth) => longBody.map((l) => (l === "" ? "" : truncateToWidth(l, innerWidth)))),
			{ label: "AURORA", borderColor: "border", labelColor: "accent" },
		);
		for (const width of [40, 60, 80, 120]) {
			const lines = card.render(width).map(stripAnsi);
			expect(lines[0].startsWith("╭── AURORA ")).toBe(true);
			expect(lines[0].endsWith("╮")).toBe(true);
			expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
			for (const l of lines) expect(visibleWidth(l)).toBe(width);
		}
	});

	test("portable +/-/| for asciiOnly themes, still width-exact", () => {
		useTheme({ layout: { messageStyle: "box", asciiOnly: true }, glyphs: ROUNDED_GLYPHS });
		const body = new Container();
		body.addChild(new Text("hi", 0, 0));
		const frame = new MessageBoxFrame(body, { label: "YOU", borderColor: "accent", labelColor: "accent" });

		const lines = frame.render(40).map(stripAnsi);
		expect(lines[0].startsWith("+-- YOU ")).toBe(true);
		expect(lines[0].endsWith("+")).toBe(true);
		expect(lines[lines.length - 1]).toMatch(/^\+-+\+$/);
		for (const l of lines) {
			expect(l.startsWith("+") || l.startsWith("|")).toBe(true);
			expect(visibleWidth(l)).toBe(40);
		}
	});

	test("UserMessageComponent renders a box with the YOU label", () => {
		useTheme({ layout: { messageStyle: "box" }, glyphs: ROUNDED_GLYPHS });
		const rendered = new UserMessageComponent("a question").render(50).map(stripAnsi);
		const joined = rendered.join("\n");
		expect(joined).toContain("╭── YOU ");
		expect(joined).toContain("a question");
		expect(joined).toContain("╰");
		// every box line is width-exact (ignore trailing OSC-marker-only lines)
		for (const l of rendered) {
			if (l.includes("╭") || l.includes("│") || l.includes("╰")) expect(visibleWidth(l)).toBe(50);
		}
	});

	test("AssistantMessageComponent renders a box with the AURORA label", () => {
		useTheme({ layout: { messageStyle: "box" }, glyphs: ROUNDED_GLYPHS });
		const component = new AssistantMessageComponent();
		component.updateContent({
			role: "assistant",
			content: [{ type: "text", text: "the answer" }],
			stopReason: "endTurn",
		} as never);
		const rendered = component.render(50).map(stripAnsi);
		const joined = rendered.join("\n");
		expect(joined).toContain("╭── AURORA ");
		expect(joined).toContain("the answer");
		for (const l of rendered) {
			if (l.includes("╭") || l.includes("│") || l.includes("╰")) expect(visibleWidth(l)).toBe(50);
		}
	});
});
