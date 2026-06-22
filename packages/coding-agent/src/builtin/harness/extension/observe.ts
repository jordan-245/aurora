// Harness v2 — observability extension (Phase 3 + 5). Subscribes to the agent-event bus and paints a live
// multi-agent dashboard above the editor (TUI mode only). Pure logic is in src/observe.ts.
// Phase 5 adds /harness-web command to serve a live HTTP/SSE dashboard.
import type { ExtensionAPI } from "../../../index.ts";
import {
	DASHBOARD_STYLES,
	type DashboardStyle,
	emptyVM,
	isAnimating,
	reduce,
	renderFooter,
	renderWidget,
	setExpanded,
} from "../src/observe.ts";
import { createWebSurface, getWebToken, type WebSurface } from "../src/web-surface.ts";

export default function observe(summon: ExtensionAPI) {
	const vm = emptyVM();
	let tuiRef: any;
	let timer: any;
	let frame = 0;
	let anim: any;
	let surface: WebSurface | undefined;
	// Pluggable dashboard layout (#layout): HARNESS_DASHBOARD picks the initial mode; /harness-layout switches live.
	// Default is hardcoded to "command-bridge" (the ops console); HARNESS_DASHBOARD still overrides it.
	let dashStyle: DashboardStyle = (DASHBOARD_STYLES as string[]).includes(process.env.HARNESS_DASHBOARD ?? "")
		? (process.env.HARNESS_DASHBOARD as DashboardStyle)
		: "command-bridge";

	// animation loop: advance the frame so running agents spin + the splash wordmark shimmers (~120ms).
	// CRITICAL: this MUST go fully quiet when idle. An always-on "idle shimmer" repaints the bottom
	// status rows ~2x/sec forever, which in tmux (and any terminal not honoring synchronized output)
	// reads as constant screen jutter — even while the user is just reading a response. So when there's
	// nothing to animate (no running agent and the boot splash has elapsed), we paint one final settled
	// frame and STOP the timer entirely (zero idle repaints). It is restarted on the next agent-event.
	const startAnim = () => {
		if (anim || !isAnimating(vm)) return;
		anim = setInterval(() => {
			frame++;
			if (isAnimating(vm)) {
				tuiRef?.requestRender?.();
			} else {
				tuiRef?.requestRender?.(); // paint the settled (idle) frame once
				stopAnim(); // then go quiet — no idle jutter
			}
		}, 120);
	};
	const stopAnim = () => {
		if (anim) {
			clearInterval(anim);
			anim = undefined;
		}
	};

	// Best-effort forward of agent-events to the PERSISTENT dashboard service (systemd, tunnelled) so it
	// shows activity from every session. Fire-and-forget: if the service isn't running, the POST is
	// swallowed. Disable with HARNESS_WEB_INGEST=0.
	const ingestUrl = `http://127.0.0.1:${process.env.HARNESS_WEB_PORT ?? 8787}/ingest`;
	const ingestOn = process.env.HARNESS_WEB_INGEST !== "0";
	let ingestToken = "";
	try {
		ingestToken = getWebToken();
	} catch {
		/* no token file yet */
	}
	const forward = (e: any) => {
		if (!ingestOn || !ingestToken) return;
		try {
			fetch(ingestUrl, {
				method: "POST",
				headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
				body: JSON.stringify(e),
			}).catch(() => {});
		} catch {
			/* fetch unavailable / swallow */
		}
	};

	const flush = () => {
		timer = undefined;
		tuiRef?.requestRender?.();
	};
	summon.events?.on?.("agent-event", (e: any) => {
		reduce(vm, e);
		surface?.push(e); // feed the session-local surface if /harness-web is running
		forward(e); // feed the persistent service if running
		startAnim(); // resume the spinner/shimmer while agents are active (self-stops when idle again)
		if (!timer) timer = setTimeout(flush, 120); // throttle: never render per-event
	});

	// Phase 5 — /harness-web command: start/stop the HTTP+SSE dashboard.
	summon.registerCommand?.("harness-web", {
		description: "Start/stop the harness web dashboard. Args: <port> | off (default: start on an ephemeral port).",
		handler: async (args: string, ctx: any) => {
			const a = (args ?? "").trim();
			if (a === "off") {
				await surface?.close();
				surface = undefined;
				ctx?.ui?.notify?.("harness web: stopped", "info");
				return;
			}
			if (surface) {
				ctx?.ui?.notify?.(`harness web already at ${surface.url}`, "info");
				return;
			}
			const [portTok, hostTok] = a.split(/\s+/);
			const port = portTok ? Number(portTok) : undefined;
			const host = hostTok || undefined; // default → loopback inside createWebSurface
			surface = await createWebSurface({ port, host });
			const exposed = surface.host === "0.0.0.0";
			ctx?.ui?.notify?.(
				`harness web: ${surface.url}` +
					(exposed
						? "  (bound to all interfaces — reachable on this box's IP; ensure your firewall allows the port)"
						: "  (loopback only — use: /harness-web <port> 0.0.0.0 to expose, or SSH-tunnel the port)"),
				exposed ? "warning" : "info",
			);
		},
	});

	summon.registerCommand?.("harness-drill", {
		description: "Drill into a harness agent's tool timeline. Args: <agentId> | next | off (default: next).",
		handler: async (args: string, ctx: any) => {
			setExpanded(vm, (args ?? "").trim() || "next");
			tuiRef?.requestRender?.();
			ctx?.ui?.notify?.(vm.expanded ? `harness: drilled into ${vm.expanded}` : "harness: drill-in off", "info");
		},
	});

	// Pluggable dashboard layout switch (#layout): flip the live widget between render modes at runtime.
	summon.registerCommand?.("harness-layout", {
		description: `Switch the live dashboard layout. Args: ${DASHBOARD_STYLES.join(" | ")} | show.`,
		handler: async (args: string, ctx: any) => {
			const a = (args ?? "").trim();
			if (!a || a === "show") {
				ctx?.ui?.notify?.(`harness layout: ${dashStyle}  (options: ${DASHBOARD_STYLES.join(", ")})`, "info");
				return;
			}
			if ((DASHBOARD_STYLES as string[]).includes(a)) {
				dashStyle = a as DashboardStyle;
				tuiRef?.requestRender?.();
				ctx?.ui?.notify?.(`harness layout → ${dashStyle}`, "info");
			} else {
				ctx?.ui?.notify?.(`unknown layout '${a}'. options: ${DASHBOARD_STYLES.join(", ")}`, "warning");
			}
		},
	});

	summon.on("session_start", async (_e: any, ctx: any) => {
		// TUI-only surface. Newer pi (≥0.79) reports ctx.mode ("tui"|"rpc"|"json"|"print"); the older
		// dev binary (pi-mono@tui-refresh-editorial, 0.75.5) has NO ctx.mode and only ever runs this in its
		// interactive TUI. So bail only when a mode IS reported and it isn't "tui"; when no mode is reported
		// (old dev binary) fall through and rely on widget capability. Guarding on the literal "tui" string
		// alone silently hid the whole dashboard under pi-dev (undefined !== "tui").
		if (ctx.mode && ctx.mode !== "tui") return;
		if (typeof ctx.ui?.setWidget !== "function") return; // no widget surface (print/json/noop ui)
		ctx.ui.setWidget(
			"harness",
			(tui: any, _theme: any) => {
				tuiRef = tui;
				return { invalidate() {}, render: (width: number) => renderWidget(vm, width, frame, dashStyle) };
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setStatus?.("harness", renderFooter(vm));
		startAnim(); // live panel comes alive (spinner + shimmer) only when agents are delegated
	});

	summon.on("session_shutdown", async (_e: any, ctx: any) => {
		stopAnim();
		await surface?.close();
		surface = undefined;
		if (!ctx.mode || ctx.mode === "tui") {
			ctx.ui?.setWidget?.("harness", undefined);
			ctx.ui?.setStatus?.("harness", undefined);
		}
	});
}
