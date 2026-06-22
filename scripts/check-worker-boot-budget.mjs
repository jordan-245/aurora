// Worker cold-start budget gate (audit item 4: "quantify the worker cold-start budget").
//
// Every spawned harness worker pays the cost of loading summon's eager module
// graph before it can do any work. This gate makes that cost a DETERMINISTIC,
// machine-independent number that can't silently regress.
//
// How: esbuild bundles the CLI entry with a metafile, then we BFS the import
// graph following ONLY static edges (import-statement / require-call) and cutting
// at dynamic `import()` boundaries. The resulting set is exactly what loads at
// process start — including node_modules. Wall-clock timing is intentionally NOT
// used here: it is machine- and load-dependent and makes flaky CI gates. A module
// budget is stable and is the thing we actually control.
//
// The gate enforces two things:
//   1. HARD ZERO — modules that must never be on the eager path (locks audit
//      items 1+2 and the lazy extension-loader): the interactive TUI, export-html
//      (highlight.js + marked), and jiti (the runtime TS transpiler).
//   2. A total eager-module BUDGET — catches a careless new top-level dependency
//      that balloons startup. Lower the budget when you make startup leaner;
//      raising it requires a deliberate edit here and should be justified.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = "packages/coding-agent/src/cli.ts";

// ── budget ──────────────────────────────────────────────────────────────────
// Measured eager graph at the time of writing: 1336 modules (typebox alone is
// 668 of these — the irreducible tool-schema type builder plus the value/compile
// validation engine; see the audit notes in this file's PR). Headroom is small
// on purpose so a large new top-level dependency trips the gate.
const EAGER_MODULE_BUDGET = 1400;

// Modules that must NEVER be reachable without crossing a dynamic import().
const FORBIDDEN = [
	{ label: "interactive TUI (interactive-mode)", re: /\/modes\/interactive\/interactive-mode\.ts$/ },
	{ label: "export-html (highlight.js + marked)", re: /\/core\/export-html\// },
	{ label: "jiti (runtime TS transpiler)", re: /(?:^|\/)node_modules\/jiti\// },
];

const result = await build({
	entryPoints: [entryPoint],
	absWorkingDir: repoRoot,
	bundle: true,
	platform: "node",
	format: "esm",
	metafile: true,
	write: false,
	logLevel: "silent",
	external: ["fsevents"],
});

const inputs = result.metafile.inputs;
const entryKey = Object.keys(inputs).find((k) => k.endsWith("coding-agent/src/cli.ts"));
if (!entryKey) {
	console.error(`check-worker-boot-budget: could not locate entry input for ${entryPoint}`);
	process.exit(1);
}

// BFS the eager graph: follow static edges only, cut at dynamic-import.
const STATIC_KINDS = new Set(["import-statement", "require-call"]);
const eager = new Set([entryKey]);
const queue = [entryKey];
while (queue.length > 0) {
	const file = queue.shift();
	for (const imp of inputs[file]?.imports ?? []) {
		if (!STATIC_KINDS.has(imp.kind)) continue; // dynamic import() is the lazy boundary
		if (!eager.has(imp.path)) {
			eager.add(imp.path);
			queue.push(imp.path);
		}
	}
}

const eagerList = [...eager];
const count = (re) => eagerList.filter((p) => re.test(p)).length;

const failures = [];
for (const { label, re } of FORBIDDEN) {
	const hits = eagerList.filter((p) => re.test(p));
	if (hits.length > 0) {
		failures.push(
			`${label} is on the EAGER boot graph (${hits.length} module(s), e.g. ${hits[0].replace(/.*node_modules\//, "node_modules/")}).\n` +
				`     It must be loaded via a dynamic import() at its use site. See scripts/check-startup-lazy-imports.mjs for the precise import chain.`,
		);
	}
}

if (eager.size > EAGER_MODULE_BUDGET) {
	failures.push(
		`eager module count ${eager.size} exceeds budget ${EAGER_MODULE_BUDGET}.\n` +
			`     A new top-level dependency likely landed. Make it lazy (dynamic import / import type), or — if it is genuinely needed at startup — raise EAGER_MODULE_BUDGET deliberately with justification.`,
	);
}

// Visibility: print the breakdown regardless of pass/fail.
console.log("worker cold-start eager module graph:");
console.log(`  total eager modules: ${eager.size} (budget ${EAGER_MODULE_BUDGET})`);
console.log(
	`  typebox: ${count(/(?:^|\/)node_modules\/typebox\//)} ` +
		`(type ${count(/typebox\/build\/type\//)}, value ${count(/typebox\/build\/value\//)}, schema ${count(/typebox\/build\/schema\//)}, compile ${count(/typebox\/build\/compile\//)})`,
);
console.log(
	`  gated (must be 0): interactive-mode ${count(/interactive-mode\.ts$/)}, export-html ${count(/core\/export-html\//)}, jiti ${count(/(?:^|\/)node_modules\/jiti\//)}`,
);

if (failures.length > 0) {
	console.error("\nWorker cold-start budget gate FAILED:");
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}

console.log("worker cold-start budget gate OK");
