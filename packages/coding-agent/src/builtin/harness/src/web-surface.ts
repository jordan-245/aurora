// Harness v2 — web surface (Phase 5). HTTP server that ingests agent-events and
// serves a live dashboard over SSE. No npm deps — only node:http + node:fs + node:crypto + node:path.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { counts, emptyVM, reduce, type ViewModel } from "./observe.ts";

// ── token helper ──────────────────────────────────────────────────────────

const TOKEN_PATH = process.env.HARNESS_WEB_TOKEN_FILE ?? join(process.env.HOME ?? homedir(), ".harness", "web-token");

/**
 * Read the shared dashboard token; generate a strong one (0600) on first call if absent.
 * Priority: HARNESS_WEB_TOKEN env var → token file → generate and persist.
 */
export function getWebToken(): string {
	if (process.env.HARNESS_WEB_TOKEN) return process.env.HARNESS_WEB_TOKEN;
	try {
		if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, "utf8").trim();
	} catch {}
	const tok = randomBytes(24).toString("base64url");
	try {
		mkdirSync(join(process.env.HOME ?? homedir(), ".harness"), { recursive: true });
		writeFileSync(TOKEN_PATH, tok, { mode: 0o600 });
	} catch {}
	return tok;
}

// ── pure helpers (unit-testable without a socket) ─────────────────────────

/** JSON-able snapshot of the live ViewModel. */
export function snapshot(vm: ViewModel) {
	const agents = [...vm.agents.values()].map((a) => ({
		id: a.id,
		agent: a.agent,
		model: a.model,
		status: a.status,
		tool: a.tool,
		verify: a.verify,
		startedAt: a.startedAt,
		endedAt: a.endedAt,
		tools: (a.timeline ?? []).length,
	}));
	return {
		counts: counts(vm),
		agents,
		startedAt: vm.startedAt,
		governor: vm.governor ?? null, // #1/#4 governor signals (null until a spawn surfaces them)
		autoscale: vm.autoscale ?? null, // #3 latest autoscaler decisions (null unless the autoscaler is armed)
	};
}

/** Self-contained HTML+JS dashboard page (no external deps). */
export function renderDashboardHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness v2 — live dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:monospace;background:#0d0d0d;color:#ccc;padding:16px}
  h1{color:#7eb8f7;font-size:1.1rem;margin-bottom:12px;letter-spacing:.05em}
  #summary{color:#aaa;font-size:.85rem;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:.82rem}
  th{text-align:left;color:#555;padding:3px 8px;border-bottom:1px solid #222}
  td{padding:3px 8px;border-bottom:1px solid #1a1a1a;vertical-align:top}
  .run{color:#7eb8f7}.done{color:#5cb85c}.bad{color:#e05c5c}
  .dot-run::before{content:"▶ "}.dot-done::before{content:"✓ "}.dot-bad::before{content:"✗ "}
  #status{font-size:.78rem;color:#555;margin-top:10px}
</style>
</head>
<body>
<h1>◆ Harness v2 — live dashboard</h1>
<div id="summary">connecting…</div>
<table>
  <thead><tr><th>agent</th><th>model</th><th>status</th><th>tool</th><th>tools</th><th>verify</th><th>started</th></tr></thead>
  <tbody id="tbody"></tbody>
</table>
<div id="status">—</div>
<script>
function cls(status){return status==='running'?'run':status==='done'?'done':'bad'}
function dot(status){return status==='running'?'dot-run':status==='done'?'dot-done':'dot-bad'}
function ts(ms){return ms?new Date(ms).toISOString().slice(11,19):'—'}

function render(state){
  const c=state.counts||{};
  document.getElementById('summary').textContent=
    'agents: '+c.total+' | running: '+c.run+' | ok: '+c.ok+' | bad: '+c.bad;
  const tbody=document.getElementById('tbody');
  tbody.innerHTML='';
  for(const a of (state.agents||[])){
    const cl=cls(a.status);
    const tr=document.createElement('tr');
    tr.innerHTML=
      '<td class="'+cl+' '+dot(a.status)+'">'+a.agent+'</td>'+
      '<td>'+a.model+'</td>'+
      '<td class="'+cl+'">'+a.status+'</td>'+
      '<td>'+(a.tool||'—')+'</td>'+
      '<td>'+a.tools+'</td>'+
      '<td>'+(a.verify===true?'✓':a.verify===false?'✗':'—')+'</td>'+
      '<td>'+ts(a.startedAt)+'</td>';
    tbody.appendChild(tr);
  }
  document.getElementById('status').textContent='last update: '+new Date().toISOString();
}

// initial state from /state
fetch('/state').then(r=>r.json()).then(render).catch(console.error);

// live updates via EventSource('/events')
const es=new EventSource('/events');
es.addEventListener('state',function(e){
  try{render(JSON.parse(e.data))}catch(err){console.error(err)}
});
es.onmessage=function(e){
  // generic agent-event: just re-fetch /state for simplicity
  fetch('/state').then(r=>r.json()).then(render).catch(console.error);
};
es.onerror=function(){
  document.getElementById('status').textContent='SSE disconnected — retrying…';
};
</script>
</body>
</html>`;
}

// ── WebSurface (live server) ───────────────────────────────────────────────

export interface WebSurface {
	/** Ingest one agent-event; updates state and fans out to SSE clients. */
	push(e: any): void;
	/** Gracefully close: drain SSE clients, close HTTP server. */
	close(): Promise<void>;
	readonly port: number;
	readonly url: string;
	readonly host: string;
}

/**
 * Start the HTTP server. Pass `port: 0` (default) for an ephemeral port.
 * Pass `token` to enable auth on ALL routes (Bearer / Basic / ?token= query).
 * When no token is set the server is fully open — existing behaviour preserved.
 * Resolves once the server is listening.
 */
export function createWebSurface(opts: { port?: number; host?: string; token?: string } = {}): Promise<WebSurface> {
	return new Promise((resolve, reject) => {
		const host = opts.host ?? "127.0.0.1";
		const token = opts.token;
		const vm = emptyVM();
		const clients = new Set<ServerResponse>();

		/**
		 * Returns true if the request is authenticated.
		 * Always true when no token is configured (back-compat).
		 * Accepts: Bearer token, HTTP Basic (any username / password===token), ?token= query param.
		 */
		const authed = (req: IncomingMessage): boolean => {
			if (!token) return true;
			const authHeader = (req.headers.authorization ?? "") as string;
			// Bearer token
			if (authHeader === `Bearer ${token}`) return true;
			// HTTP Basic auth — any username, password must equal token
			if (authHeader.startsWith("Basic ")) {
				try {
					const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
					const colon = decoded.indexOf(":");
					if (colon !== -1 && decoded.slice(colon + 1) === token) return true;
				} catch {}
			}
			// Query param ?token=
			try {
				const u = new URL(req.url ?? "/", "http://x");
				if (u.searchParams.get("token") === token) return true;
			} catch {}
			return false;
		};

		/** Reduce an event into the VM and broadcast a raw data frame to all SSE clients. */
		const doPush = (e: any): void => {
			reduce(vm, e);
			const line = `data: ${JSON.stringify(e)}\n\n`;
			for (const c of clients) {
				try {
					c.write(line);
				} catch {
					/* client may have disconnected */
				}
			}
		};

		const server: Server = createServer((req, res) => {
			// ── auth gate ─────────────────────────────────────────────────────────
			if (!authed(req)) {
				res.writeHead(401, {
					"Content-Type": "text/plain",
					"WWW-Authenticate": 'Basic realm="harness"',
				});
				res.end("unauthorized");
				return;
			}

			// Resolve pathname (strips query string) for routing.
			const rawUrl = req.url ?? "/";
			let pathname = rawUrl;
			try {
				pathname = new URL(rawUrl, "http://x").pathname;
			} catch {}

			// ── GET / — dashboard HTML ────────────────────────────────────────────
			if (pathname === "/") {
				const body = renderDashboardHtml();
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Length": Buffer.byteLength(body),
				});
				res.end(body);
				return;
			}

			// ── GET /state — JSON snapshot ────────────────────────────────────────
			if (pathname === "/state") {
				const body = JSON.stringify(snapshot(vm));
				res.writeHead(200, {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				});
				res.end(body);
				return;
			}

			// ── GET /events — SSE stream ──────────────────────────────────────────
			if (pathname === "/events") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				});
				// Send initial state snapshot as a named "state" event so the client
				// can render without waiting for the first push().
				const initial = `event: state\ndata: ${JSON.stringify(snapshot(vm))}\n\n`;
				res.write(initial);
				clients.add(res);
				req.on("close", () => clients.delete(res));
				return;
			}

			// ── POST /ingest — external event feed ───────────────────────────────
			if (pathname === "/ingest" && req.method === "POST") {
				const MAX_BYTES = 262144; // 256 KB hard cap
				const chunks: Buffer[] = [];
				let size = 0;
				let over = false;

				req.on("data", (chunk: Buffer) => {
					if (over) return;
					size += chunk.length;
					if (size > MAX_BYTES) {
						over = true;
						res.writeHead(413, { "Content-Type": "text/plain" });
						res.end("payload too large");
						return;
					}
					chunks.push(chunk);
				});

				req.on("end", () => {
					if (over || res.headersSent) return;
					const raw = Buffer.concat(chunks).toString("utf8");
					let events: any[];
					try {
						const parsed = JSON.parse(raw);
						events = Array.isArray(parsed) ? parsed : [parsed];
					} catch {
						res.writeHead(400, { "Content-Type": "text/plain" });
						res.end("bad JSON");
						return;
					}
					for (const e of events) doPush(e);
					res.writeHead(204);
					res.end();
				});

				req.on("error", () => {
					/* body-read error: connection lost, nothing to respond */
				});
				return;
			}

			// ── 404 ───────────────────────────────────────────────────────────────
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
		});

		server.on("error", reject);

		server.listen(opts.port ?? 0, host, () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("unexpected address type"));
				return;
			}
			const port = addr.port;
			const url = `http://${host}:${port}`;

			const surface: WebSurface = {
				get port() {
					return port;
				},
				get url() {
					return url;
				},
				get host() {
					return host;
				},

				push(e: any): void {
					doPush(e);
				},

				close(): Promise<void> {
					return new Promise((res) => {
						for (const c of clients) {
							try {
								c.end();
							} catch {
								/* already closed */
							}
						}
						clients.clear();
						server.close(() => res());
					});
				},
			};

			resolve(surface);
		});
	});
}
