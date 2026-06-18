import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { type ToolBlockStyle, theme } from "../theme/theme.ts";
import { boxBodyWidth, wrapBoxBody } from "./box-frame.ts";

// ============================================================================
// IndentedToolFrame — gutter + running-header + body + footer pill
// ============================================================================

interface IndentFrameState {
	toolName: string;
	isPartial: boolean;
	isError: boolean;
	startTimeMs: number | undefined;
	endTimeMs: number | undefined;
	hasResult: boolean;
}

// Elapsed-time label for a tool frame, single-sourced so all four call sites agree.
// CRITICAL: once a tool completes we use the FROZEN endTimeMs, never Date.now() — a finished
// card's footer is then a pure function of frozen state and never changes between renders.
// Live Date.now() is used ONLY while the tool is still running (the single bottom-most, on-screen
// card). Without this freeze every completed card's elapsed digits tick on every render frame;
// off-screen cards then mutate the logical buffer ~12-16x/sec, forcing full-screen redraws
// (visible scroll/jitter under tmux) on every keystroke and spinner tick.
function frameElapsed(state: IndentFrameState): string {
	if (!state.startTimeMs) return state.isPartial ? "" : "?s";
	const end = state.isPartial ? Date.now() : (state.endTimeMs ?? Date.now());
	return `${((end - state.startTimeMs) / 1000).toFixed(1)}s`;
}

/**
 * Wraps a body Container in an editorial-style indented frame:
 *
 *   [gutter] toolname · running ·················  0.4s   (while running)
 *   [gutter] <body lines>
 *   [gutter] ──────────────  ok  ·  2.4s            (on completion)
 */
class IndentedToolFrame implements Component {
	private innerContainer: Container;
	private getState: () => IndentFrameState;

	constructor(innerContainer: Container, getState: () => IndentFrameState) {
		this.innerContainer = innerContainer;
		this.getState = getState;
	}

	invalidate(): void {
		this.innerContainer.invalidate?.();
	}

	render(width: number): string[] {
		const gutter = theme.toolGutter();
		const gutterStr = " ".repeat(gutter);
		const bodyWidth = Math.max(1, width - gutter);
		const state = this.getState();

		const lines: string[] = [];

		if (state.isPartial) {
			// ── Running header ─────────────────────────────────────────────
			const elapsed = frameElapsed(state);
			const toolDot = theme.glyph("toolDots");
			const prefix = `${state.toolName} · running `;
			const elapsedDisplay = elapsed ? ` ${elapsed}` : "";
			const dotsCount = Math.max(0, width - gutter - prefix.length - elapsedDisplay.length);
			lines.push(gutterStr + theme.fg("muted", prefix + toolDot.repeat(dotsCount) + elapsedDisplay));
			// blank line after running header
			lines.push("");
		}

		// ── Body (indented) ────────────────────────────────────────────────
		const bodyLines = this.innerContainer.render(bodyWidth);
		for (const line of bodyLines) {
			lines.push(gutterStr + line);
		}

		if (!state.isPartial && state.hasResult) {
			// ── Completion footer ──────────────────────────────────────────
			const elapsed = frameElapsed(state);
			const hrChar = theme.glyph("hr");
			const pill = state.isError ? theme.glyph("errorPill") : theme.glyph("successPill");
			const pillColor: "error" | "success" = state.isError ? "error" : "success";
			const elapsedPart = `  ·  ${elapsed}`;
			// hr fills: width - gutter - 1(space) - pill.len - elapsed.len
			const hrCount = Math.max(0, width - gutter - 1 - pill.length - elapsedPart.length);
			// blank line before footer
			lines.push("");
			lines.push(
				gutterStr +
					theme.fg("muted", hrChar.repeat(hrCount)) +
					" " +
					theme.fg(pillColor, pill) +
					theme.fg("muted", elapsedPart),
			);
		}

		return lines;
	}
}

// ============================================================================
// AsciiBoxFrame — +--[ tool ]--+ ASCII framing (brutalist / commit 3)
// ============================================================================

/**
 * Renders tool content inside a box whose corners/edges are theme glyphs.
 *   Portable ASCII (default):      Rounded (e.g. harness-pro):
 *     +--[ bash ]--------+           ╭── bash ──────╮
 *     | echo "hi"        |           │ echo "hi"        │
 *     +--[ ok ]-- 2.4s --+           ╰── ✓ ──── 2.4s ──╯
 * Corners/edges come from boxTL/TR/BL/BR/H/V glyphs; the tool name is accented
 * (toolTitle) and the completion pill is semantic. asciiOnly themes always get
 * the portable +/-/| set regardless of glyph config.
 */
class AsciiBoxFrame implements Component {
	private innerContainer: Container;
	private getState: () => IndentFrameState;

	constructor(innerContainer: Container, getState: () => IndentFrameState) {
		this.innerContainer = innerContainer;
		this.getState = getState;
	}

	invalidate(): void {
		this.innerContainer.invalidate?.();
	}

	render(width: number): string[] {
		const state = this.getState();

		// Box-drawing glyphs are theme-driven (rounded / heavy / ascii). asciiOnly themes (brutalist)
		// always render the portable +/-/| set so they are identical on every terminal.
		const ascii = theme.isAsciiOnly();
		const tl = ascii ? "+" : theme.glyph("boxTL") || "+";
		const tr = ascii ? "+" : theme.glyph("boxTR") || "+";
		const bl = ascii ? "+" : theme.glyph("boxBL") || "+";
		const br = ascii ? "+" : theme.glyph("boxBR") || "+";
		const h = ascii ? "-" : theme.glyph("boxH") || "-";
		const v = ascii ? "|" : theme.glyph("boxV") || "|";
		const bo = theme.glyph("toolBracketOpen"); // "[" by default; "" for a bracket-less rounded card
		const bc = theme.glyph("toolBracketClose"); // "]" by default
		const edge = (s: string) => theme.fg("border", s);

		// ── Top border ─────────────────────────────────────────────────────
		// tl h h bo  <tool>  bc h…h tr
		const topLabel = `${bo} ${state.toolName} ${bc}`; // visible label segment
		const topFill = Math.max(0, width - 1 /*tl*/ - 2 /*hh*/ - topLabel.length - 1 /*tr*/);
		const topBorder =
			edge(`${tl}${h}${h}${bo} `) +
			theme.fg("toolTitle", theme.bold(state.toolName)) +
			edge(` ${bc}${h.repeat(topFill)}${tr}`);

		// ── Body ───────────────────────────────────────────────────────────
		const bodyWidth = boxBodyWidth(width); // "v " + " v"
		const bodyLines = this.innerContainer.render(bodyWidth);

		// ── Bottom border ──────────────────────────────────────────────────
		let bottomBorder: string;
		if (!state.isPartial && state.hasResult) {
			const elapsed = frameElapsed(state);
			const pill = state.isError ? theme.glyph("errorPill") : theme.glyph("successPill");
			const pillColor: "error" | "success" = state.isError ? "error" : "success";
			// bl h h bo  <pill>  bc h…h  <elapsed>  h h br
			const pillWidth = visibleWidth(pill);
			// non-fill widths: "{bl}{h}{h}{bo} "(4+bo) + pill + " {bc} "(2+bc) + elapsed + " {h}{h}{br}"(4)
			const botFill = Math.max(0, width - 10 - bo.length - bc.length - pillWidth - elapsed.length);
			bottomBorder =
				edge(`${bl}${h}${h}${bo} `) +
				theme.fg(pillColor, pill) +
				edge(` ${bc}${h.repeat(botFill)} `) +
				theme.fg("muted", elapsed) +
				edge(` ${h}${h}${br}`);
		} else {
			const elapsed = frameElapsed(state);
			const runText = `running${theme.glyph("ellipsis")}${elapsed ? ` ${elapsed}` : ""}`;
			const runLabel = `${bo} ${runText} ${bc}`; // visible label segment
			const botFill = Math.max(0, width - 1 - 2 - runLabel.length - 1);
			bottomBorder =
				edge(`${bl}${h}${h}${bo} `) + theme.fg("muted", runText) + edge(` ${bc}${h.repeat(botFill)}${br}`);
		}

		// Body padding (the off-by-one-prone math) is single-sourced in wrapBoxBody — see box-frame.ts.
		return [topBorder, ...wrapBoxBody(bodyLines, bodyWidth, v, edge), bottomBorder];
	}
}

// ============================================================================
// ToolExecutionComponent
// ============================================================================

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	// ── indent / ascii-box mode ───────────────────────────────────────────
	private indentContainer: Container;
	private indentFrame: IndentedToolFrame | AsciiBoxFrame | undefined;
	private startTimeMs: number | undefined;
	private endTimeMs: number | undefined;
	private toolBlockStyleAtConstruct: ToolBlockStyle;
	// ─────────────────────────────────────────────────────────────────────
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		// Snapshot toolBlockStyle at construction time.
		// Theme switches call ui.invalidate() → updateDisplay() for bg/color changes.
		// Layout changes (fill↔indent) take effect on the next session.
		this.toolBlockStyleAtConstruct = theme.toolBlockStyle();

		// Leading spacer — always present regardless of style
		this.addChild(new Spacer(1));

		// Always create all shell variants.
		// contentBox: fill-mode renderer composition.
		// selfRenderContainer: tool "self" render shell (fill mode).
		// contentText: generic fallback for no-definition tools (fill mode).
		// indentContainer: body container for indent / ascii-box modes.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();
		this.indentContainer = new Container();

		const style = this.toolBlockStyleAtConstruct;

		if (style === "indent" || style === "ascii-box") {
			// ── Indented / ascii-box framing ──────────────────────────────
			const getState = (): IndentFrameState => ({
				toolName: this.toolName,
				isPartial: this.isPartial,
				isError: this.result?.isError ?? false,
				startTimeMs: this.startTimeMs,
				endTimeMs: this.endTimeMs,
				hasResult: this.result !== undefined,
			});

			if (style === "ascii-box") {
				this.indentFrame = new AsciiBoxFrame(this.indentContainer, getState);
			} else {
				this.indentFrame = new IndentedToolFrame(this.indentContainer, getState);
			}
			this.addChild(this.indentFrame);
		} else {
			// ── Fill framing (legacy default) ─────────────────────────────
			if (this.hasRendererDefinition()) {
				this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
			} else {
				this.addChild(this.contentText);
			}
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		// Capture start time for elapsed-time display in indent / ascii-box modes
		if (this.startTimeMs === undefined) {
			this.startTimeMs = Date.now();
		}
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		// Freeze the elapsed clock the moment the tool first reports a final (non-partial) result,
		// so the completed card stops re-rendering. Freeze-once: the first completion timestamp wins.
		if (!isPartial && this.endTimeMs === undefined) {
			this.endTimeMs = Date.now();
		}
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		const style = this.toolBlockStyleAtConstruct;

		// ── Indent / ascii-box mode ─────────────────────────────────────────
		if (style === "indent" || style === "ascii-box") {
			this.hideComponent = false;
			this.indentContainer.clear();

			let hasContent = false;

			if (this.hasRendererDefinition()) {
				const callRenderer = this.getCallRenderer();
				if (!callRenderer) {
					this.indentContainer.addChild(this.createCallFallback());
					hasContent = true;
				} else {
					try {
						const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
						this.callRendererComponent = component;
						this.indentContainer.addChild(component);
						hasContent = true;
					} catch {
						this.callRendererComponent = undefined;
						this.indentContainer.addChild(this.createCallFallback());
						hasContent = true;
					}
				}

				if (this.result) {
					const resultRenderer = this.getResultRenderer();
					if (!resultRenderer) {
						const component = this.createResultFallback();
						if (component) {
							this.indentContainer.addChild(component);
							hasContent = true;
						}
					} else {
						try {
							const component = resultRenderer(
								{ content: this.result.content as any, details: this.result.details },
								{ expanded: this.expanded, isPartial: this.isPartial },
								theme,
								this.getRenderContext(this.resultRendererComponent),
							);
							this.resultRendererComponent = component;
							this.indentContainer.addChild(component);
							hasContent = true;
						} catch {
							this.resultRendererComponent = undefined;
							const component = this.createResultFallback();
							if (component) {
								this.indentContainer.addChild(component);
								hasContent = true;
							}
						}
					}
				}
			} else {
				// No renderer definition: format as text in indent container (no bg)
				const text = this.formatToolExecution();
				if (text) {
					this.indentContainer.addChild(new Text(text, 0, 0));
					hasContent = true;
				}
			}

			// The frame always renders a running header, so only hide when truly empty + complete
			if (!hasContent && !this.isPartial) {
				this.hideComponent = true;
			}

			this.rebuildImageComponents();
			return;
		}

		// ── Fill mode (legacy / dark / light) ──────────────────────────────
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		this.rebuildImageComponents();

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	/** Remove old image components and rebuild from current result. */
	private rebuildImageComponents(): void {
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
