/**
 * box-frame.ts
 *
 * Single-sourced box-drawing primitives shared by every framed renderer
 * (tool cards via AsciiBoxFrame, chat messages via MessageBoxFrame).
 *
 * WHY THIS FILE EXISTS (the bug class it closes):
 *   The body-line padding math — strip trailing space, measure with
 *   `visibleWidth` (ANSI-aware), pad to an exact inner width — is the classic
 *   off-by-one source for box frames. It used to live inline in AsciiBoxFrame.
 *   Re-implementing it per renderer guarantees the two drift. `wrapBoxBody`
 *   is now the ONE implementation; both frames call it, so a width-exact
 *   parity test on either guards both.
 *
 * Box-drawing glyphs are theme-driven (rounded ╭╮╰╯, heavy, or portable +/-/|).
 * `asciiOnly` themes always get the portable +/-/| set regardless of glyph
 * config, so they render identically on every terminal.
 */

import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";

export interface BoxGlyphs {
	tl: string;
	tr: string;
	bl: string;
	br: string;
	h: string;
	v: string;
}

/** Resolve the active theme's box-drawing glyphs (portable +/-/| for asciiOnly themes). */
export function boxGlyphs(): BoxGlyphs {
	const ascii = theme.isAsciiOnly();
	return {
		tl: ascii ? "+" : theme.glyph("boxTL") || "+",
		tr: ascii ? "+" : theme.glyph("boxTR") || "+",
		bl: ascii ? "+" : theme.glyph("boxBL") || "+",
		br: ascii ? "+" : theme.glyph("boxBR") || "+",
		h: ascii ? "-" : theme.glyph("boxH") || "-",
		v: ascii ? "|" : theme.glyph("boxV") || "|",
	};
}

/**
 * Inner body width for a frame of the given outer width.
 * The body is inset by `v ` on the left and ` v` on the right (4 cells).
 */
export function boxBodyWidth(width: number): number {
	return Math.max(1, width - 4);
}

/**
 * Wrap pre-rendered body lines in vertical edges, padding each to exactly
 * `bodyWidth` visible cells. THIS is the single source of the off-by-one-prone
 * padding math — every framed renderer must route through it.
 *
 * @param bodyLines pre-rendered (possibly ANSI-coloured) content lines
 * @param bodyWidth target inner width (use {@link boxBodyWidth})
 * @param v vertical edge glyph
 * @param edge colour wrapper applied to the edge glyphs (e.g. theme.fg("border", …))
 */
export function wrapBoxBody(bodyLines: string[], bodyWidth: number, v: string, edge: (s: string) => string): string[] {
	const out: string[] = [];
	for (const line of bodyLines) {
		// Strip trailing spaces then pad to bodyWidth using visibleWidth (handles all ANSI codes).
		const stripped = line.replace(/\s+$/, "");
		const padCount = Math.max(0, bodyWidth - visibleWidth(stripped));
		out.push(`${edge(`${v} `)}${stripped}${" ".repeat(padCount)}${edge(` ${v}`)}`);
	}
	return out;
}

// ============================================================================
// MessageBoxFrame — a clean rounded box around a chat message
// ============================================================================

export interface MessageBoxOptions {
	/** Label shown in the top border (already-cased text, e.g. "YOU" / "AURORA"). */
	label: string;
	/** Theme colour for the box edges. */
	borderColor: ThemeColor;
	/** Theme colour for the role label in the top border. */
	labelColor: ThemeColor;
}

/**
 * Wraps any renderable body Component in a titled rounded box:
 *
 *   ╭── YOU ─────────────────────────────╮
 *   │ message text, markdown-rendered     │
 *   ╰─────────────────────────────────────╯
 *
 * Corners/edges are theme glyphs (portable +/-/| for asciiOnly themes). The
 * role label is accent-coloured + bold; edges use `borderColor`. Body padding
 * is delegated to {@link wrapBoxBody} so it can never drift from the tool card.
 */
export class MessageBoxFrame implements Component {
	private inner: Component;
	private opts: MessageBoxOptions;

	constructor(inner: Component, opts: MessageBoxOptions) {
		this.inner = inner;
		this.opts = opts;
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		const g = boxGlyphs();
		const edge = (s: string) => theme.fg(this.opts.borderColor, s);
		const label = this.opts.label;

		// ── Top border: tl h h " " LABEL " " h…h tr ──────────────────────────
		// Fixed cells = tl(1)+h(1)+h(1)+space(1) + label + space(1) + tr(1) = 6 + label.
		const topFill = Math.max(0, width - 6 - visibleWidth(label));
		const topBorder =
			edge(`${g.tl}${g.h}${g.h} `) +
			theme.bold(theme.fg(this.opts.labelColor, label)) +
			edge(` ${g.h.repeat(topFill)}${g.tr}`);

		// ── Body ─────────────────────────────────────────────────────────────
		const bodyWidth = boxBodyWidth(width);
		const bodyLines = wrapBoxBody(this.inner.render(bodyWidth), bodyWidth, g.v, edge);

		// ── Bottom border: bl h…h br ──────────────────────────────────────────
		const bottomBorder = edge(`${g.bl}${g.h.repeat(Math.max(0, width - 2))}${g.br}`);

		return [topBorder, ...bodyLines, bottomBorder];
	}
}
