import * as fs from "node:fs";
import * as path from "node:path";
import {
	type EditorTheme,
	getCapabilities,
	type MarkdownTheme,
	type SelectListTheme,
	type SettingsListTheme,
} from "@summon/tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getCustomThemesDir, getThemesDir } from "../../../config.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.ts";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";

// ============================================================================
// Types & Schema
// ============================================================================

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

// ── Phase 1: glyph + layout schemas ──────────────────────────────────────
const GlyphValueSchema = Type.String();
const NumberSchema = Type.Number();

const RoleStyleSchema = Type.Union([Type.Literal("none"), Type.Literal("smallcaps"), Type.Literal("bracket")]);

const MessageStyleSchema = Type.Union([
	Type.Literal("fill"),
	Type.Literal("rule"),
	Type.Literal("bracket"),
	Type.Literal("box"),
]);

const ToolBlockStyleSchema = Type.Union([Type.Literal("fill"), Type.Literal("indent"), Type.Literal("ascii-box")]);

const InputAreaStyleSchema = Type.Union([Type.Literal("border-fill"), Type.Literal("rules-only")]);

const GlyphsSchema = Type.Optional(
	Type.Object({
		hr: Type.Optional(GlyphValueSchema),
		bullet1: Type.Optional(GlyphValueSchema),
		bullet2: Type.Optional(GlyphValueSchema),
		middleDot: Type.Optional(GlyphValueSchema),
		ellipsis: Type.Optional(GlyphValueSchema),
		submitHint: Type.Optional(GlyphValueSchema),
		spinnerFrames: Type.Optional(Type.Array(GlyphValueSchema)),
		spinnerIntervalMs: Type.Optional(NumberSchema),
		toolDots: Type.Optional(GlyphValueSchema),
		toolBracketOpen: Type.Optional(GlyphValueSchema),
		toolBracketClose: Type.Optional(GlyphValueSchema),
		// Box-drawing glyphs for the ascii-box tool frame. Defaults reproduce the
		// portable +/-/| look; a theme can opt into rounded (╭╮╰╯ ─ │) or heavy borders.
		boxTL: Type.Optional(GlyphValueSchema),
		boxTR: Type.Optional(GlyphValueSchema),
		boxBL: Type.Optional(GlyphValueSchema),
		boxBR: Type.Optional(GlyphValueSchema),
		boxH: Type.Optional(GlyphValueSchema),
		boxV: Type.Optional(GlyphValueSchema),
		successPill: Type.Optional(GlyphValueSchema),
		errorPill: Type.Optional(GlyphValueSchema),
		workingLabel: Type.Optional(GlyphValueSchema),
	}),
);

// ── Phase 3: signature gradient + startup wordmark banner ────────────────
// Both are OPTIONAL: themes that omit them render exactly as before (the plain
// bold-accent logo, a flat-coloured spinner). A theme opts into the premium look
// by declaring a `gradient` (drives the banner + the animated spinner) and a
// `banner` (multi-line ASCII wordmark painted with that gradient).
const GradientSchema = Type.Optional(Type.Array(ColorValueSchema));
const BannerSchema = Type.Optional(
	Type.Object({
		lines: Type.Array(Type.String()),
		tagline: Type.Optional(Type.String()),
	}),
);

const LayoutSchema = Type.Optional(
	Type.Object({
		messageStyle: Type.Optional(MessageStyleSchema),
		toolBlockStyle: Type.Optional(ToolBlockStyleSchema),
		inputAreaStyle: Type.Optional(InputAreaStyleSchema),
		roleLabelStyle: Type.Optional(RoleStyleSchema),
		userRoleLabel: Type.Optional(Type.String()),
		assistantRoleLabel: Type.Optional(Type.String()),
		toolGutter: Type.Optional(NumberSchema),
		blankLineBetweenTurns: Type.Optional(NumberSchema),
		footerStyle: Type.Optional(Type.Union([Type.Literal("two-line"), Type.Literal("single-line")])),
		footerSeparator: Type.Optional(GlyphValueSchema),
		spinnerStyle: Type.Optional(Type.Union([Type.Literal("dots"), Type.Literal("wave")])),
		bannerAnimation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("comet"), Type.Literal("constellation")]),
		),

		asciiOnly: Type.Optional(Type.Boolean()),
	}),
);
// ── End glyph + layout schemas ────────────────────────────────────────────

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (10 colors)
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// Backgrounds & Content Text (11 colors)
		selectedBg: ColorValueSchema,
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (6 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		// Bash Mode (1 color)
		bashMode: ColorValueSchema,
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
	glyphs: GlyphsSchema,
	layout: LayoutSchema,
	gradient: GradientSchema,
	banner: BannerSchema,
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

// ── Phase 1: exported types + defaults ───────────────────────────────────

/** Style variants for message bubble rendering. */
export type MessageStyle = "fill" | "rule" | "bracket" | "box";
/** Style variants for tool-call block rendering. */
export type ToolBlockStyle = "fill" | "indent" | "ascii-box";
/** Style variants for the input-area chrome. */
export type InputAreaStyle = "border-fill" | "rules-only";
/** Style variants for role-label headers. */
export type RoleStyle = "none" | "smallcaps" | "bracket";
/** Style variants for the footer row. */
export type FooterStyle = "two-line" | "single-line";
/** Working-loader spinner: `dots` = single breathing glyph; `wave` = summon ribbon. */
export type SpinnerStyle = "dots" | "wave";
export type BannerAnimation = "none" | "comet" | "constellation";

/** Keys for the string-valued glyph table (excludes spinnerFrames / spinnerIntervalMs). */
export type GlyphName =
	| "hr"
	| "bullet1"
	| "bullet2"
	| "middleDot"
	| "ellipsis"
	| "submitHint"
	| "toolDots"
	| "toolBracketOpen"
	| "toolBracketClose"
	| "boxTL"
	| "boxTR"
	| "boxBL"
	| "boxBR"
	| "boxH"
	| "boxV"
	| "successPill"
	| "errorPill"
	| "workingLabel";

/** Map from each layout key to its concrete return type (used by the generic accessor). */
export type LayoutValueByName = {
	messageStyle: MessageStyle;
	toolBlockStyle: ToolBlockStyle;
	inputAreaStyle: InputAreaStyle;
	roleLabelStyle: RoleStyle;
	userRoleLabel: string;
	assistantRoleLabel: string;
	toolGutter: number;
	blankLineBetweenTurns: number;
	footerStyle: FooterStyle;
	footerSeparator: string;
	spinnerStyle: SpinnerStyle;
	bannerAnimation: BannerAnimation;
	asciiOnly: boolean;
};

export type LayoutName = keyof LayoutValueByName;

type ResolvedGlyphs = {
	hr: string;
	bullet1: string;
	bullet2: string;
	middleDot: string;
	ellipsis: string;
	submitHint: string;
	spinnerFrames: string[];
	spinnerIntervalMs: number;
	toolDots: string;
	toolBracketOpen: string;
	toolBracketClose: string;
	boxTL: string;
	boxTR: string;
	boxBL: string;
	boxBR: string;
	boxH: string;
	boxV: string;
	successPill: string;
	errorPill: string;
	workingLabel: string;
};

type ResolvedLayout = LayoutValueByName;

/** Resolved startup wordmark banner (ASCII-art lines + optional tagline). */
export type ResolvedBanner = {
	lines: string[];
	tagline?: string;
};

/** Default glyph values — matches the existing dark/light visual identity. */
export const DEFAULT_GLYPHS: ResolvedGlyphs = {
	hr: "─",
	bullet1: "•",
	bullet2: "◦",
	middleDot: " · ",
	ellipsis: "…",
	submitHint: "⏎",
	spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	spinnerIntervalMs: 80,
	toolDots: "·",
	toolBracketOpen: "[",
	toolBracketClose: "]",
	// Defaults match the original hard-coded ascii-box look (+ corners, - edges, | sides).
	boxTL: "+",
	boxTR: "+",
	boxBL: "+",
	boxBR: "+",
	boxH: "-",
	boxV: "|",
	successPill: "ok",
	errorPill: "fail",
	workingLabel: "Working...",
};

/** Default layout values — preserves the current dark/light filled-background look. */
export const DEFAULT_LAYOUT: ResolvedLayout = {
	messageStyle: "fill",
	toolBlockStyle: "fill",
	inputAreaStyle: "border-fill",
	roleLabelStyle: "none",
	userRoleLabel: "You",
	assistantRoleLabel: "Assistant",
	toolGutter: 0,
	blankLineBetweenTurns: 1,
	footerStyle: "two-line",
	footerSeparator: "   ",
	spinnerStyle: "dots",
	bannerAnimation: "none",
	asciiOnly: false,
};

// ── End Phase 1 defaults ──────────────────────────────────────────────────

const validateThemeJson = Compile(ThemeJsonSchema);

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

type ColorMode = "truecolor" | "256color";

// ============================================================================
// Color Utilities
// ============================================================================

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

// The 6x6x6 color cube channel values (indices 0-5)
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// Grayscale ramp values (indices 232-255, 24 grays from 8 to 238)
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	// Weighted Euclidean distance (human eye is more sensitive to green)
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
	// Find closest color in the 6x6x6 cube
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// Find closest grayscale
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// Check if color has noticeable saturation (hue matters)
	// If max-min spread is significant, prefer cube to preserve tint
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// Only consider grayscale if color is nearly neutral (spread < 10)
	// AND grayscale is actually closer
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;
	private resolvedGlyphs: ResolvedGlyphs;
	private resolvedLayout: ResolvedLayout;
	/** Signature gradient hex stops (optional). Drives the banner + animated spinner. */
	private resolvedGradient: string[] | undefined;
	/** Startup wordmark banner (optional). */
	private resolvedBanner: ResolvedBanner | undefined;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
		options: {
			name?: string;
			sourcePath?: string;
			sourceInfo?: SourceInfo;
			glyphs?: ResolvedGlyphs;
			layout?: ResolvedLayout;
			gradient?: string[];
			banner?: ResolvedBanner;
		} = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
		this.resolvedGlyphs = options.glyphs ?? {
			...DEFAULT_GLYPHS,
			spinnerFrames: [...DEFAULT_GLYPHS.spinnerFrames],
		};
		this.resolvedLayout = options.layout ?? { ...DEFAULT_LAYOUT };
		this.resolvedGradient = options.gradient && options.gradient.length > 0 ? [...options.gradient] : undefined;
		this.resolvedBanner = options.banner
			? { lines: [...options.banner.lines], tagline: options.banner.tagline }
			: undefined;
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}

	// ── Phase 1: glyph + layout accessors ─────────────────────────────────

	/** Return the named string glyph, falling back to the built-in default. */
	glyph(name: GlyphName): string {
		return this.resolvedGlyphs[name];
	}

	/** Generic typed layout accessor — Phase 2 renderers use this. */
	layout<K extends LayoutName>(name: K): LayoutValueByName[K] {
		return this.resolvedLayout[name] as LayoutValueByName[K];
	}

	/** Resolved spinner animation frames. */
	spinnerFrames(): string[] {
		return [...this.resolvedGlyphs.spinnerFrames];
	}

	/** Resolved spinner animation interval in milliseconds. */
	spinnerIntervalMs(): number {
		return this.resolvedGlyphs.spinnerIntervalMs;
	}

	/** Whether the theme is configured for ASCII-only output. */
	isAsciiOnly(): boolean {
		return this.resolvedLayout.asciiOnly;
	}

	/** Human-readable role label for the given conversation role. */
	roleLabel(role: "user" | "assistant"): string {
		return role === "user" ? this.resolvedLayout.userRoleLabel : this.resolvedLayout.assistantRoleLabel;
	}

	messageStyle(): MessageStyle {
		return this.resolvedLayout.messageStyle;
	}

	toolBlockStyle(): ToolBlockStyle {
		return this.resolvedLayout.toolBlockStyle;
	}

	inputAreaStyle(): InputAreaStyle {
		return this.resolvedLayout.inputAreaStyle;
	}

	roleLabelStyle(): RoleStyle {
		return this.resolvedLayout.roleLabelStyle;
	}

	toolGutter(): number {
		return this.resolvedLayout.toolGutter;
	}

	blankLineBetweenTurns(): number {
		return this.resolvedLayout.blankLineBetweenTurns;
	}

	footerStyle(): FooterStyle {
		return this.resolvedLayout.footerStyle;
	}

	footerSeparator(): string {
		return this.resolvedLayout.footerSeparator;
	}

	// ── End Phase 1 accessors ──────────────────────────────────────────────

	// ── Phase 3: signature gradient + wordmark banner ──────────────────────

	/** The theme's signature gradient hex stops, or undefined if none configured. */
	signatureGradient(): string[] | undefined {
		return this.resolvedGradient ? [...this.resolvedGradient] : undefined;
	}

	/**
	 * Interpolate a list of hex stops at position t∈[0,1] → "#rrggbb".
	 * `cyclic` wraps the last stop back to the first for a seamless colour loop
	 * (used by the breathing spinner). Pure + deterministic.
	 */
	gradientAt(t: number, stops?: string[], cyclic = false): string {
		const base = stops ?? this.resolvedGradient ?? [];
		if (base.length === 0) return "#ffffff";
		if (base.length === 1) return base[0];
		const ramp = cyclic ? [...base, base[0]] : base;
		const clamped = Math.min(1, Math.max(0, t));
		const seg = clamped * (ramp.length - 1);
		const i = Math.min(ramp.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = hexToRgb(ramp[i]);
		const b = hexToRgb(ramp[i + 1]);
		const mix = (x: number, y: number) => Math.round(x + (y - x) * f);
		const hex = (n: number) => n.toString(16).padStart(2, "0");
		return `#${hex(mix(a.r, b.r))}${hex(mix(a.g, b.g))}${hex(mix(a.b, b.b))}`;
	}

	/** Wrap `text` in a single hex colour (mode-aware: truecolor or nearest-256). */
	colorizeHex(hex: string, text: string): string {
		return `${fgAnsi(hex, this.mode)}${text}\x1b[39m`;
	}

	/**
	 * Colour each visible character of `text` along a gradient (defaults to the
	 * theme's signature gradient). Spaces are left uncoloured. Returns the text
	 * unchanged when no gradient is configured.
	 */
	gradientText(text: string, stops?: string[]): string {
		const ramp = stops ?? this.resolvedGradient;
		if (!ramp || ramp.length === 0) return text;
		const chars = [...text];
		const n = chars.length;
		let out = "";
		for (let i = 0; i < n; i++) {
			const ch = chars[i];
			if (ch === " ") {
				out += " ";
				continue;
			}
			const t = n <= 1 ? 0 : i / (n - 1);
			out += this.colorizeHex(this.gradientAt(t, ramp), ch);
		}
		return out;
	}

	/**
	 * Render the wordmark banner with a column-aligned horizontal gradient: the
	 * colour of a character depends on its column across the FULL banner width, so
	 * the gradient stays vertically aligned between rows of differing length.
	 * Returns undefined when the theme declares no banner.
	 */
	bannerLines(): string[] | undefined {
		const banner = this.resolvedBanner;
		if (!banner) return undefined;
		const ramp = this.resolvedGradient;
		const width = Math.max(1, ...banner.lines.map((l) => [...l].length));
		return banner.lines.map((line) => {
			const chars = [...line];
			let out = "";
			for (let col = 0; col < chars.length; col++) {
				const ch = chars[col];
				if (ch === " ") {
					out += " ";
					continue;
				}
				if (!ramp || ramp.length === 0) {
					out += ch;
					continue;
				}
				const t = width <= 1 ? 0 : col / (width - 1);
				out += this.colorizeHex(this.gradientAt(t, ramp), ch);
			}
			return out;
		});
	}

	/** The widest banner row in cells (0 when no banner). */
	bannerWidth(): number {
		if (!this.resolvedBanner) return 0;
		return Math.max(0, ...this.resolvedBanner.lines.map((l) => [...l].length));
	}

	/** Optional tagline rendered under the banner. */
	bannerTagline(): string | undefined {
		return this.resolvedBanner?.tagline;
	}

	/**
	 * Build animated spinner frames whose colour breathes through the signature
	 * gradient (one full cyclic sweep across the frame set). Returns undefined
	 * when no gradient is configured, so callers fall back to a flat colour.
	 */
	gradientSpinnerFrames(): string[] | undefined {
		const ramp = this.resolvedGradient;
		if (!ramp || ramp.length === 0) return undefined;
		const frames = this.resolvedGlyphs.spinnerFrames;
		const n = frames.length;
		return frames.map((frame, i) => {
			const t = n <= 1 ? 0 : i / n; // i/n (not n-1) → seamless wrap with cyclic
			return this.colorizeHex(this.gradientAt(t, ramp, true), frame);
		});
	}

	/**
	 * Summon "wave-ribbon" working spinner: a single smooth, symmetric crest of light
	 * (a raised-cosine swell of block glyphs ▁▂▃▄▅▆▇█) that glides across the ribbon
	 * and wraps seamlessly, while the gradient colours travel through it with a per-frame
	 * phase offset — so both the swell AND the colours flow like the summon borealis. The
	 * crest is unimodal every frame (one clean wave, never a busy multi-bump equalizer) and
	 * every frame has identical visible width (correct-by-construction — no hand-authored
	 * frames that could drift off-width and jitter the loader). Returns undefined
	 * unless the theme opts in (`layout.spinnerStyle: "wave"`) AND a gradient exists,
	 * so non-premium themes fall through to the breathing/flat spinner. Pure +
	 * deterministic (frames built once at theme load).
	 */
	summonSpinnerFrames(): string[] | undefined {
		if (this.resolvedLayout.spinnerStyle !== "wave") return undefined;
		const ramp = this.resolvedGradient;
		if (!ramp || ramp.length === 0) return undefined;
		const levels = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]; // 8 rising 1-cell blocks (crest tops out at a full block)
		const width = 7; // ribbon cells
		const frameCount = 24; // 24 frames → a long, fluid seamless loop
		const maxLevel = levels.length - 1;
		const frames: string[] = [];
		for (let f = 0; f < frameCount; f++) {
			const phase = f / frameCount; // 0..1 → the crest travels one full ring, seamless wrap
			let frame = "";
			for (let x = 0; x < width; x++) {
				// height: ONE smooth, symmetric crest of light sweeping across the ribbon. A raised
				// cosine on a ring (peak at `phase`, `dist` = wrap-around distance from it in [0, 0.5])
				// → a single clean summon swell with an even falloff on both sides — never a busy,
				// multi-bump equalizer. Correct-by-construction: the crest is unimodal every frame.
				const dist = Math.abs(((((x / width - phase + 0.5) % 1) + 1) % 1) - 0.5);
				const norm = Math.cos(dist * Math.PI) ** 2; // 1 at the crest → 0 half a ring away
				const level = Math.min(maxLevel, Math.round(norm * maxLevel));
				// colour also travels (offset by phase) → the swell shimmers through the gradient
				const t = (x / (width - 1) + phase) % 1;
				frame += this.colorizeHex(this.gradientAt(t, ramp, true), levels[level]);
			}
			frames.push(frame);
		}
		return frames;
	}

	/** Linear-interpolate two hex colours → "#rrggbb" (t clamped to [0,1]). Pure. */
	private mixHex(a: string, b: string, t: number): string {
		const x = hexToRgb(a);
		const y = hexToRgb(b);
		const f = Math.min(1, Math.max(0, t));
		const m = (p: number, q: number) => Math.round(p + (q - p) * f);
		const h = (n: number) => n.toString(16).padStart(2, "0");
		return `#${h(m(x.r, y.r))}${h(m(x.g, y.g))}${h(m(x.b, y.b))}`;
	}

	/**
	 * Summon "comet" banner ("Comet Glint"): a CONTINUOUS, seamless-looping animation of the neon-tube
	 * wordmark where (a) the signature gradient drifts boldly through the tubes (a whole number of
	 * cyclic passes per loop — clearly visible hue motion) with soft light bands gliding around each
	 * letter, and (b) a bright white glint sweeps left→right through the word every loop, shedding a
	 * fading comet trail of particles. The frames render a small character grid (the wordmark plus one
	 * spray row above/below). It loops seamlessly: the gradient + bands complete whole cycles, and the
	 * comet is fully off-screen at both ends of the loop, so frame[N−1] → frame[0] has no seam.
	 * Pure + deterministic (built once at theme load; a fixed-seed PRNG sets the trail's scatter so it
	 * is reproducible). Returns undefined unless the theme opts in (`layout.bannerAnimation: "comet"`)
	 * AND a gradient + banner exist AND the wordmark is separable into letters by blank columns.
	 */
	summonBannerCometFrames(): string[] | undefined {
		const anim = this.resolvedLayout.bannerAnimation;
		if (anim === "constellation") return this.summonBannerConstellationFrames();
		if (anim !== "comet") return undefined;
		const banner = this.resolvedBanner;
		const ramp = this.resolvedGradient;
		if (!banner || !ramp || ramp.length === 0) return undefined;
		const rows = banner.lines.map((l) => [...l]);
		const H = rows.length;
		if (H === 0) return undefined;
		const W = Math.max(1, ...rows.map((r) => r.length));
		if (W <= 1) return undefined;

		// Segment the wordmark into letters by fully-blank columns (a separator column is space in
		// every row). Each filled cell's angular position around its letter centroid drives the pulse.
		const colBlank = (c: number) => rows.every((r) => (r[c] ?? " ") === " ");
		const letterOf = new Array<number>(W).fill(-1);
		let li = -1;
		let prevBlank = true;
		for (let c = 0; c < W; c++) {
			const blank = colBlank(c);
			if (!blank && prevBlank) li++;
			if (!blank) letterOf[c] = li;
			prevBlank = blank;
		}
		const letterCount = li + 1;
		if (letterCount < 1) return undefined;

		const centroid = Array.from({ length: letterCount }, () => ({ r: 0, c: 0, n: 0 }));
		const filled: { r: number; c: number; ch: string }[] = [];
		for (let r = 0; r < H; r++) {
			for (let c = 0; c < rows[r].length; c++) {
				const ch = rows[r][c];
				if (ch === " ") continue;
				filled.push({ r, c, ch });
				const l = letterOf[c];
				if (l < 0) continue;
				centroid[l].r += r;
				centroid[l].c += c;
				centroid[l].n++;
			}
		}
		const angleParam = (r: number, c: number): number => {
			const l = letterOf[c];
			if (l < 0 || centroid[l].n === 0) return 0;
			const cy = centroid[l].r / centroid[l].n;
			const cx = centroid[l].c / centroid[l].n;
			const ang = Math.atan2(r - cy, c - cx) / (2 * Math.PI);
			return ((ang % 1) + 1) % 1;
		};

		// ── character grid: wordmark band + one spray row above/below for the comet shower ──
		const PAD = 1;
		const GR = H + 2 * PAD; // grid rows
		const GC = W; // grid cols
		const mid = PAD + (H - 1) / 2; // comet flies along the vertical middle
		// fixed-seed PRNG → the trail's vertical scatter is a stable shape that translates with the comet
		let seed = 0x9e3779b9 >>> 0;
		const rng = () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const TRAIL = 24; // particles in the comet tail
		const TRAILLEN = 14; // tail length in columns
		const voff = Array.from({ length: TRAIL }, () => (rng() - 0.5) * (GR - 1)); // stable vertical scatter

		const frameCount = 56; // ~4.2s loop at 75ms/frame
		const driftCycles = 2; // BOLD: gradient does 2 full cyclic passes per loop (very visible hue motion)
		const laps = 1; // soft bands circle each letter once per loop
		const sigma = 0.16;
		const bandAmp = 0.22; // gentle tube shimmer (the comet is the star highlight)
		const breatheAmp = 0.1;
		const wrap = (x: number) => ((x % 1) + 1) % 1;
		const frames: string[] = [];
		type Cell = { ch: string; col: string; tube: boolean; a: number };
		for (let f = 0; f < frameCount; f++) {
			const phase = f / frameCount; // 0..1, wraps seamlessly
			const breathe = breatheAmp * (0.5 + 0.5 * Math.sin(phase * 2 * Math.PI));
			const grid: (Cell | null)[] = new Array(GR * GC).fill(null);
			// (1) neon tubes — bold drifting gradient + soft outline bands
			for (const { r, c, ch } of filled) {
				const base = this.gradientAt(wrap((W <= 1 ? 0 : c / (W - 1)) + phase * driftCycles), ramp, true);
				let b = 0;
				const pp = angleParam(r, c);
				for (const off of [0, 0.5]) {
					let d = Math.abs(wrap(pp - (phase * laps + off)));
					d = Math.min(d, 1 - d);
					b = Math.max(b, Math.exp(-(d * d) / (2 * sigma * sigma)));
				}
				grid[(PAD + r) * GC + c] = {
					ch,
					col: this.mixHex(base, "#ffffff", Math.min(0.9, bandAmp * b + breathe)),
					tube: true,
					a: 1,
				};
			}
			// (2) comet — head sweeps L→R, fully off-screen at both ends → seamless loop
			const headCol = -TRAILLEN + phase * (W + 3 * TRAILLEN);
			const plot = (grf: number, gcf: number, alpha: number, rgbHex: string, glyphs: string[]) => {
				if (alpha <= 0.05) return;
				const r = Math.round(grf);
				const c = Math.round(gcf);
				if (r < 0 || r >= GR || c < 0 || c >= GC) return;
				const i = r * GC + c;
				const cell = grid[i];
				if (cell?.tube) {
					cell.col = this.mixHex(cell.col, "#ffffff", Math.min(0.75, alpha * 0.75)); // comet glints the tube
					return;
				}
				const g = alpha < 0.34 ? glyphs[0] : alpha < 0.68 ? glyphs[1] : glyphs[2];
				const shown = this.mixHex("#0a0b14", rgbHex, Math.min(1, 0.3 + alpha * 0.85));
				if (!cell || alpha > cell.a) grid[i] = { ch: g, col: shown, tube: false, a: alpha };
			};
			for (let j = TRAIL - 1; j >= 0; j--) {
				const col = headCol - j * (TRAILLEN / TRAIL);
				const a = (1 - j / TRAIL) * 0.85;
				plot(mid + voff[j], col, a, this.gradientAt(wrap(col / W + phase), ramp, true), ["·", "•", "●"]);
			}
			plot(mid, headCol, 1, "#ffffff", ["●", "●", "●"]); // bright comet head
			// (3) emit — every row padded to GC cells (constant width → no jitter)
			const out: string[] = [];
			for (let r = 0; r < GR; r++) {
				let line = "";
				for (let c = 0; c < GC; c++) {
					const cell = grid[r * GC + c];
					line += cell ? this.colorizeHex(cell.col, cell.ch) : " ";
				}
				out.push(line);
			}
			frames.push(out.join("\n"));
		}
		return frames;
	}

	/**
	 * Constellation Forge banner — the wordmark assembles from star-points and connecting lines,
	 * then solidifies into glyphs in ice-blue→violet. Loops seamlessly: the star field twinkles,
	 * constellation lines pulse gently, and the gradient drifts across the solidified wordmark.
	 *
	 * Terminal-adaptive: the frame grid is exactly the wordmark dimensions (no fixed padding) so
	 * it behaves identically to the comet banner and is safely clipped by the TUI header widget.
	 */
	private summonBannerConstellationFrames(): string[] | undefined {
		if (this.resolvedLayout.bannerAnimation !== "constellation") return undefined;
		const banner = this.resolvedBanner;
		const ramp = this.resolvedGradient;
		if (!banner || !ramp || ramp.length === 0) return undefined;

		const rows = banner.lines.map((l) => [...l]);
		const H = rows.length;
		if (H === 0) return undefined;
		const W = Math.max(1, ...rows.map((r) => r.length));
		if (W <= 1) return undefined;

		// All non-space cells
		const filled: { r: number; c: number; ch: string }[] = [];
		for (let r = 0; r < H; r++)
			for (let c = 0; c < rows[r].length; c++) if (rows[r][c] !== " ") filled.push({ r, c, ch: rows[r][c] });

		// Star field — stable, seeded positions that twinkle each frame
		let seed = 0xdeadbeef >>> 0;
		const prng = () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const PAD = 2; // rows above + below wordmark for ambient stars
		const GR = H + 2 * PAD;
		const GC = W;

		const STAR_COUNT = Math.min(60, Math.floor(GR * GC * 0.04));
		const stars = Array.from({ length: STAR_COUNT }, () => ({
			r: Math.floor(prng() * GR),
			c: Math.floor(prng() * GC),
			mag: prng(),
			twk: prng(),
			ch: [".", "·", "∙", "*", "✦", "✧"][Math.floor(prng() * 6)],
		}));

		// Per-filled-cell stable random magnitude for twinkling star-dots
		const cellMag = new Map<string, number>();
		for (const { r, c } of filled) cellMag.set(`${r},${c}`, prng());

		const wrap = (x: number) => ((x % 1) + 1) % 1;

		// Horizontal connecting lines within a row between adjacent filled cells
		const rowConnections: Array<{ r: number; c1: number; c2: number }> = [];
		for (let r = 0; r < H; r++) {
			const cells = filled.filter((p) => p.r === r).sort((a, b) => a.c - b.c);
			for (let i = 0; i < cells.length - 1; i++) {
				const gap = cells[i + 1].c - cells[i].c;
				if (gap > 0 && gap <= 4)
					// only within a letter — skip inter-letter gaps
					rowConnections.push({ r, c1: cells[i].c, c2: cells[i + 1].c });
			}
		}

		const frameCount = 64; // ~4.8s at 75ms
		const frames: string[] = [];

		for (let f = 0; f < frameCount; f++) {
			const phase = f / frameCount; // [0,1) seamless
			const grid: Array<{ ch: string; col: string } | null> = new Array(GR * GC).fill(null);

			const setCell = (r: number, c: number, ch: string, col: string) => {
				if (r < 0 || r >= GR || c < 0 || c >= GC) return;
				grid[r * GC + c] = { ch, col };
			};

			// (1) Ambient star field — twinkle
			for (const s of stars) {
				const brightness = s.mag * (0.35 + 0.28 * Math.sin((phase + s.twk) * Math.PI * 4.5));
				if (brightness < 0.08) continue;
				const t = Math.max(0, Math.min(1, s.mag));
				const col = this.gradientAt(t, ["#6db4ff", "#8b95ff", "#eef1ff"]);
				const scaled = this.mixHex("#0a0b14", col, brightness * 1.4);
				setCell(s.r, s.c, s.ch, scaled);
			}

			// (2) Constellation lines — pulse gently
			for (const { r, c1, c2 } of rowConnections) {
				const linePulse = 0.28 + 0.18 * Math.sin(phase * Math.PI * 2 + c1 * 0.4);
				for (let dc = 1; dc < c2 - c1; dc++) {
					const t = wrap((c1 + dc) / W + phase * 0.5);
					const col = this.gradientAt(t, ["#34e1f4", "#6db4ff", "#8b95ff"], true);
					setCell(PAD + r, c1 + dc, "─", this.mixHex("#0a0b14", col, linePulse));
				}
			}

			// (3) Wordmark — solid glyphs with drifting constellation gradient
			for (const { r, c, ch } of filled) {
				// Drift: gradient moves right slowly; each letter has a subtle phase offset
				const gp = wrap(c / W + phase * 1.1);
				const baseCol = this.gradientAt(gp, ["#34e1f4", "#8b95ff", "#b69cff", "#f06ffb"], true);
				// Gentle per-cell twinkle — star-like glint on filled glyphs
				const mag = cellMag.get(`${r},${c}`) ?? 0.5;
				const twinkle = 1 + 0.22 * Math.sin(phase * Math.PI * 4.5 + c * 0.5 + mag * 6);
				const col = this.mixHex(baseCol, "#ffffff", Math.min(0.5, (twinkle - 1) * 0.8));
				setCell(PAD + r, c, ch, col);
			}

			// (4) Emit — pad every row to GC for constant width (no TUI jitter)
			const out: string[] = [];
			for (let r = 0; r < GR; r++) {
				let line = "";
				for (let c = 0; c < GC; c++) {
					const cell = grid[r * GC + c];
					line += cell ? this.colorizeHex(cell.col, cell.ch) : " ";
				}
				out.push(line);
			}
			frames.push(out.join("\n"));
		}
		return frames;
	}

	/** Frame interval (ms) for the continuous summon comet banner. */
	bannerCometIntervalMs(): number {
		return 75;
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const themesDir = getThemesDir();
		BUILTIN_THEMES = {
			dark: JSON.parse(fs.readFileSync(path.join(themesDir, "dark.json"), "utf-8")) as ThemeJson,
			light: JSON.parse(fs.readFileSync(path.join(themesDir, "light.json"), "utf-8")) as ThemeJson,
		};
		// Phase 1: load new built-in themes when present (bundled with the package)
		for (const name of ["editorial", "brutalist", "summon", "harness"]) {
			const p = path.join(themesDir, `${name}.json`);
			if (fs.existsSync(p)) {
				BUILTIN_THEMES[name] = JSON.parse(fs.readFileSync(p, "utf-8")) as ThemeJson;
			}
		}
	}
	return BUILTIN_THEMES;
}

export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const themesDir = getThemesDir();
	const result: ThemeInfo[] = [];
	const seen = new Set<string>();
	const addTheme = (themeInfo: ThemeInfo) => {
		if (seen.has(themeInfo.name)) {
			return;
		}
		seen.add(themeInfo.name);
		result.push(themeInfo);
	};

	// Built-in themes
	for (const name of Object.keys(getBuiltinThemes())) {
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// Custom themes
	for (const themeInfo of getCustomThemeInfos()) {
		addTheme(themeInfo);
	}

	for (const [name, theme] of registeredThemes.entries()) {
		addTheme({ name, path: theme.sourcePath });
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

function getCustomThemeInfos(): ThemeInfo[] {
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];
	if (!fs.existsSync(customThemesDir)) {
		return result;
	}

	for (const file of fs.readdirSync(customThemesDir)) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			const customTheme = loadThemeFromPath(themePath);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: themePath });
			}
		} catch {
			// Invalid themes are ignored here; the resource loader reports them
			// during normal startup/reload.
		}
	}
	return result;
}

function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	return json as ThemeJson;
}

function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? (getCapabilities().trueColor ? "truecolor" : "256color");
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	// ── Phase 1: resolve glyphs + layout from JSON, merging with defaults ─
	const jsonGlyphs = themeJson.glyphs ?? {};
	const glyphs: ResolvedGlyphs = {
		hr: jsonGlyphs.hr ?? DEFAULT_GLYPHS.hr,
		bullet1: jsonGlyphs.bullet1 ?? DEFAULT_GLYPHS.bullet1,
		bullet2: jsonGlyphs.bullet2 ?? DEFAULT_GLYPHS.bullet2,
		middleDot: jsonGlyphs.middleDot ?? DEFAULT_GLYPHS.middleDot,
		ellipsis: jsonGlyphs.ellipsis ?? DEFAULT_GLYPHS.ellipsis,
		submitHint: jsonGlyphs.submitHint ?? DEFAULT_GLYPHS.submitHint,
		spinnerFrames: jsonGlyphs.spinnerFrames ? [...jsonGlyphs.spinnerFrames] : [...DEFAULT_GLYPHS.spinnerFrames],
		spinnerIntervalMs: jsonGlyphs.spinnerIntervalMs ?? DEFAULT_GLYPHS.spinnerIntervalMs,
		toolDots: jsonGlyphs.toolDots ?? DEFAULT_GLYPHS.toolDots,
		toolBracketOpen: jsonGlyphs.toolBracketOpen ?? DEFAULT_GLYPHS.toolBracketOpen,
		toolBracketClose: jsonGlyphs.toolBracketClose ?? DEFAULT_GLYPHS.toolBracketClose,
		boxTL: jsonGlyphs.boxTL ?? DEFAULT_GLYPHS.boxTL,
		boxTR: jsonGlyphs.boxTR ?? DEFAULT_GLYPHS.boxTR,
		boxBL: jsonGlyphs.boxBL ?? DEFAULT_GLYPHS.boxBL,
		boxBR: jsonGlyphs.boxBR ?? DEFAULT_GLYPHS.boxBR,
		boxH: jsonGlyphs.boxH ?? DEFAULT_GLYPHS.boxH,
		boxV: jsonGlyphs.boxV ?? DEFAULT_GLYPHS.boxV,
		successPill: jsonGlyphs.successPill ?? DEFAULT_GLYPHS.successPill,
		errorPill: jsonGlyphs.errorPill ?? DEFAULT_GLYPHS.errorPill,
		workingLabel: jsonGlyphs.workingLabel ?? DEFAULT_GLYPHS.workingLabel,
	};
	const jsonLayout = themeJson.layout ?? {};
	const layout: ResolvedLayout = {
		messageStyle: jsonLayout.messageStyle ?? DEFAULT_LAYOUT.messageStyle,
		toolBlockStyle: jsonLayout.toolBlockStyle ?? DEFAULT_LAYOUT.toolBlockStyle,
		inputAreaStyle: jsonLayout.inputAreaStyle ?? DEFAULT_LAYOUT.inputAreaStyle,
		roleLabelStyle: jsonLayout.roleLabelStyle ?? DEFAULT_LAYOUT.roleLabelStyle,
		userRoleLabel: jsonLayout.userRoleLabel ?? DEFAULT_LAYOUT.userRoleLabel,
		assistantRoleLabel: jsonLayout.assistantRoleLabel ?? DEFAULT_LAYOUT.assistantRoleLabel,
		toolGutter: jsonLayout.toolGutter ?? DEFAULT_LAYOUT.toolGutter,
		blankLineBetweenTurns: jsonLayout.blankLineBetweenTurns ?? DEFAULT_LAYOUT.blankLineBetweenTurns,
		footerStyle: jsonLayout.footerStyle ?? DEFAULT_LAYOUT.footerStyle,
		footerSeparator: jsonLayout.footerSeparator ?? DEFAULT_LAYOUT.footerSeparator,
		spinnerStyle: jsonLayout.spinnerStyle ?? DEFAULT_LAYOUT.spinnerStyle,
		bannerAnimation: jsonLayout.bannerAnimation ?? DEFAULT_LAYOUT.bannerAnimation,
		asciiOnly: jsonLayout.asciiOnly ?? DEFAULT_LAYOUT.asciiOnly,
	};
	// ── End Phase 1 resolution ────────────────────────────────────────────

	// ── Phase 3: resolve signature gradient + banner ──────────────────────
	// Gradient stops may be var refs ("accent") or hex; resolve to hex and drop
	// any non-hex (256-index) stops since the gradient needs RGB to interpolate.
	const vars = themeJson.vars ?? {};
	const gradient: string[] | undefined = themeJson.gradient
		? themeJson.gradient
				.map((stop) => resolveVarRefs(stop, vars))
				.filter((c): c is string => typeof c === "string" && c.startsWith("#"))
		: undefined;
	const banner: ResolvedBanner | undefined = themeJson.banner
		? { lines: [...themeJson.banner.lines], tagline: themeJson.banner.tagline }
		: undefined;
	// ── End Phase 3 resolution ────────────────────────────────────────────

	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
		glyphs,
		layout,
		gradient: gradient && gradient.length > 0 ? gradient : undefined,
		banner,
	});
}

export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

function loadTheme(name: string, mode?: ColorMode): Theme {
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

export type TerminalTheme = "dark" | "light";

export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export interface TerminalThemeDetection {
	theme: TerminalTheme;
	source: "terminal background" | "COLORFGBG" | "fallback";
	detail: string;
	confidence: "high" | "low";
}

export interface TerminalThemeDetectionOptions {
	env?: NodeJS.ProcessEnv;
}

function getColorFgBgBackgroundIndex(colorfgbg: string): number | undefined {
	const parts = colorfgbg.split(";");
	for (let i = parts.length - 1; i >= 0; i--) {
		const bg = parseInt(parts[i].trim(), 10);
		if (Number.isInteger(bg) && bg >= 0 && bg <= 255) {
			return bg;
		}
	}
	return undefined;
}

function getRgbColorLuminance({ r, g, b }: RgbColor): number {
	const toLinear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getAnsiColorLuminance(index: number): number {
	return getRgbColorLuminance(hexToRgb(ansi256ToHex(index)));
}

export function getThemeForRgbColor(rgb: RgbColor): TerminalTheme {
	return getRgbColorLuminance(rgb) >= 0.5 ? "light" : "dark";
}

function parseOscHexChannel(channel: string): number | undefined {
	if (!/^[0-9a-f]+$/i.test(channel)) {
		return undefined;
	}
	const max = 16 ** channel.length - 1;
	if (max <= 0) {
		return undefined;
	}
	return Math.round((parseInt(channel, 16) / max) * 255);
}

export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
	const match = data.match(/^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i);
	if (!match) {
		return undefined;
	}

	const value = match[1].trim();
	if (value.startsWith("#")) {
		const hex = value.slice(1);
		if (/^[0-9a-f]{6}$/i.test(hex)) {
			return hexToRgb(value);
		}
		if (/^[0-9a-f]{12}$/i.test(hex)) {
			const r = parseOscHexChannel(hex.slice(0, 4));
			const g = parseOscHexChannel(hex.slice(4, 8));
			const b = parseOscHexChannel(hex.slice(8, 12));
			return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
		}
		return undefined;
	}

	const rgbValue = value.replace(/^rgba?:/i, "");
	const [red, green, blue] = rgbValue.split("/");
	if (red === undefined || green === undefined || blue === undefined) {
		return undefined;
	}
	const r = parseOscHexChannel(red);
	const g = parseOscHexChannel(green);
	const b = parseOscHexChannel(blue);
	return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
}

export function detectTerminalBackground(options: TerminalThemeDetectionOptions = {}): TerminalThemeDetection {
	const env = options.env ?? process.env;
	const colorfgbg = env.COLORFGBG || "";
	const bg = getColorFgBgBackgroundIndex(colorfgbg);
	if (bg !== undefined) {
		return {
			theme: getAnsiColorLuminance(bg) >= 0.5 ? "light" : "dark",
			source: "COLORFGBG",
			detail: `background color index ${bg}`,
			confidence: "high",
		};
	}

	return {
		theme: "dark",
		source: "fallback",
		detail: "no terminal background hint found",
		confidence: "low",
	};
}

export function getDefaultTheme(): string {
	// Summon is the product's signature look — the full neon TUI out of the box.
	// Switch anytime via `summon themes <name>` (e.g. editorial, dark, light).
	return "summon";
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (tsx + jiti in dev mode)
const THEME_KEY = Symbol.for("@summon/coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@summon/coding-agent:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (tsx, jiti) see the same theme
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let themeReloadTimer: NodeJS.Timeout | undefined;
let onThemeChangeCallback: (() => void) | undefined;
const registeredThemes = new Map<string, Theme>();

export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			registeredThemes.set(theme.name, theme);
		}
	}
}

export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// Theme is invalid - fall back to dark theme silently
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // Can't watch a direct instance
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

function startThemeWatcher(): void {
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	if (
		!currentThemeName ||
		currentThemeName === "dark" ||
		currentThemeName === "light" ||
		currentThemeName === "editorial" ||
		currentThemeName === "brutalist"
	) {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// Reload the theme from disk and refresh the registry cache
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// Notify callback (to invalidate UI)
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// Ignore errors (file might be in invalid state while being edited)
			}
		}, 100);
	};

	themeWatcher =
		watchWithErrorHandler(
			customThemesDir,
			(_eventType, filename) => {
				if (currentThemeName !== watchedThemeName) {
					return;
				}
				if (!filename) {
					scheduleReload();
					return;
				}
				if (filename !== watchedFileName) {
					return;
				}
				scheduleReload();
			},
			() => {
				closeWatcher(themeWatcher);
				themeWatcher = undefined;
			},
		) ?? undefined;
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	closeWatcher(themeWatcher);
	themeWatcher = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = loadThemeJson(name);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// Default text color for empty values (terminal uses default fg color)
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Check if a theme is a "light" theme (for CSS that needs light/dark variants).
 */
export function isLightTheme(themeName?: string): boolean {
	// Currently just check the name - could be extended to analyze colors
	return themeName === "light";
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: ColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return ansi256ToHex(resolved);
			if (resolved === "") return undefined;
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// Skip highlighting when no valid language is specified. cli-highlight's
	// auto-detection is unreliable and can misidentify prose as AppleScript,
	// LiveCodeServer, etc., coloring random English words as keywords.
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			// Validate language before highlighting to avoid stderr spam from cli-highlight
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			// Skip highlighting when no valid language is specified. cli-highlight's
			// auto-detection is unreliable and can misidentify prose as AppleScript,
			// LiveCodeServer, etc., coloring random English words as keywords.
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
