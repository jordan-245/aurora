#!/usr/bin/env node
// Scripted fake `summon` CLI for harness end-to-end tests (A4). The harness spawns a real subprocess
// per sub-agent (`summon -p --mode json` / `--mode rpc`); the in-process FAUX provider only intercepts
// the PARENT session, never these child spawns. So a true e2e of spawn_quorum / plan_and_run / resume
// needs a stand-in CLI that speaks the same NDJSON contract WITHOUT a provider, network, or auth.
//
// Contract (matches src/core.ts spawnOnce / rpc-worker parsing):
//   • `--version`            → print a semver to stderr, exit 0 (the spawn-smoke launch check).
//   • `-p --mode json`       → read the prompt from stdin, emit ONE NDJSON `message_end` line whose
//                              assistant text is the final answer, exit 0.
//   • `--mode rpc`           → a minimal line-protocol worker: for each `{type:"run",...}` request line
//                              on stdin, reply with a `message_end` line (so the warm-pool path works).
//
// The reply is deterministic and depends only on the prompt text, so votes/contracts are reproducible:
//   • a PLANNER prompt (contains the planner's marker) → a fenced ```json blueprint referencing `tester`.
//   • anything else → a "## result" answer (satisfies the test agents' output contract).

import process from "node:process";

const args = process.argv.slice(2);

if (args.includes("--version")) {
	process.stderr.write("9.9.9-fake\n");
	process.exit(0);
}

// Deterministic answer text for a given prompt.
function answerFor(prompt) {
	if (prompt.includes("Emit ONLY the blueprint") || prompt.includes("blueprint DAG")) {
		const bp = {
			name: "auto-demo",
			description: "fake generated plan",
			nodes: [{ id: "step1", agent: "tester", prompt: "do the thing" }],
		};
		return "Here is the plan:\n\n```json\n" + JSON.stringify(bp, null, 2) + "\n```\n";
	}
	return "## result\nfake worker output (deterministic)\n";
}

function messageEndLine(text) {
	return `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
}

function readAllStdin() {
	return new Promise((resolve) => {
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (d) => {
			buf += d;
		});
		process.stdin.on("end", () => resolve(buf));
	});
}

const isRpc = args.includes("rpc"); // `--mode rpc`

if (!isRpc) {
	// one-shot json: prompt arrives on stdin, single message_end out.
	const prompt = await readAllStdin();
	process.stdout.write(messageEndLine(answerFor(prompt)));
	process.exit(0);
} else {
	// rpc worker: speak the exact protocol RpcWorker (src/rpc-worker.ts) expects from a real
	// `summon --mode rpc` server, so the warm-pool transport works end-to-end:
	//   {type:"prompt", message, id}  → {type:"response", id, success:true} + message_end + agent_end
	//   {type:"new_session", id}      → {type:"response", id, success:true}   (WarmPool.release reset)
	process.stdin.setEncoding("utf8");
	let buf = "";
	const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
	process.stdin.on("data", (d) => {
		buf += d;
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
			if (!line.trim()) continue;
			let req;
			try {
				req = JSON.parse(line);
			} catch {
				continue;
			}
			if (req?.type === "prompt") {
				write({ type: "response", id: req.id, success: true });
				const text = answerFor(String(req.message ?? ""));
				write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
				write({ type: "agent_end" });
			} else if (req?.id) {
				// new_session and any other id-correlated command: acknowledge so the worker stays healthy.
				write({ type: "response", id: req.id, success: true });
			}
		}
	});
	process.stdin.on("end", () => process.exit(0));
}
