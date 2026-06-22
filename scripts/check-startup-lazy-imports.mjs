// Structural guard for startup weight (see audit: "make summon lightweight & fast").
//
// Walks the EAGER static import graph of the coding-agent CLI starting at
// packages/coding-agent/src/cli.ts and fails if it can statically reach any
// module that must stay lazy. "Eager" = a normal `import ... from "x"` or
// `export ... from "x"`. We deliberately DO NOT follow:
//   - `import type` / fully type-only named imports (erased at runtime), or
//   - dynamic `import("x")` (the intended lazy boundary).
//
// Forbidden-on-the-eager-path targets and why:
//   - modes/interactive/interactive-mode.ts  — the ~212KB interactive TUI graph;
//     must not load in -p / json / rpc / spawned-worker processes.
//   - core/export-html/**                    — highlight.js + marked + template;
//     only the --export command and in-session exportToHtml need it.
//   - jiti / jiti/static                     — the runtime TS transpiler; only
//     needed when a TS extension is actually loaded.
//
// If this guard fails, you almost certainly added a top-level `import` of one of
// these (or of a barrel that re-exports it). Convert it to a dynamic `import()`
// at the use site, or to `import type`, instead of relaxing this check.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(repoRoot, "packages", "coding-agent", "src");
const entry = join(srcRoot, "cli.ts");

// A reached file matches a forbidden target.
function classifyFile(absPath) {
	const rel = relative(srcRoot, absPath).replaceAll("\\", "/");
	if (rel === "modes/interactive/interactive-mode.ts") return "interactive TUI (interactive-mode.ts)";
	if (rel.startsWith("core/export-html/")) return "export-html (highlight.js + marked)";
	return undefined;
}

// A bare specifier that must never be eagerly imported.
function classifyBare(specifier) {
	if (specifier === "jiti" || specifier.startsWith("jiti/")) return "jiti (runtime TS transpiler)";
	return undefined;
}

function resolveRelative(fromFile, specifier) {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = base.endsWith(".ts") ? [base] : [`${base}.ts`, join(base, "index.ts")];
	return candidates.find((c) => existsSync(c));
}

// Collect eager (runtime) module specifiers from one source file.
function eagerSpecifiers(file) {
	const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const specs = [];

	const isFullyTypeOnlyNamed = (clause) => {
		if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
		const els = clause.namedBindings.elements;
		return els.length > 0 && els.every((e) => e.isTypeOnly);
	};

	const visit = (node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			const clause = node.importClause;
			const typeOnly = clause?.isTypeOnly || (clause && !clause.name && isFullyTypeOnlyNamed(clause));
			// `import "x"` (no clause) is a side-effecting eager import; keep it.
			if (!typeOnly) specs.push(node.moduleSpecifier.text);
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier) &&
			!node.isTypeOnly
		) {
			specs.push(node.moduleSpecifier.text);
		}
		// Note: dynamic import() call expressions are intentionally NOT collected.
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return specs;
}

// BFS the eager graph, remembering how we got to each node for a readable trace.
const visited = new Set([entry]);
const parent = new Map();
const queue = [entry];
const violations = [];

function chain(file) {
	const path = [];
	let cur = file;
	while (cur) {
		path.unshift(relative(srcRoot, cur).replaceAll("\\", "/"));
		cur = parent.get(cur);
	}
	return path.join("\n      -> ");
}

while (queue.length > 0) {
	const file = queue.shift();
	for (const specifier of eagerSpecifiers(file)) {
		if (specifier.startsWith(".")) {
			const target = resolveRelative(file, specifier);
			if (!target) continue; // unresolved (e.g. asset) — not our concern
			const why = classifyFile(target);
			if (why) {
				parent.set(target, file);
				violations.push(`${why}\n   reached via:\n      ${chain(target)}`);
				continue; // don't recurse past a forbidden node; one report is enough
			}
			if (!visited.has(target)) {
				visited.add(target);
				parent.set(target, file);
				queue.push(target);
			}
		} else {
			const why = classifyBare(specifier);
			if (why) {
				violations.push(`${why}\n   eagerly imported by: ${relative(srcRoot, file).replaceAll("\\", "/")}`);
			}
		}
	}
}

if (violations.length > 0) {
	console.error("Startup lazy-import guard FAILED — these must not be on the eager import graph of cli.ts:\n");
	for (const v of violations) console.error(`- ${v}\n`);
	console.error(
		"Fix: use a dynamic import() at the use site (or `import type`) instead of a top-level import.\n" +
			"See scripts/check-startup-lazy-imports.mjs for the rationale.",
	);
	process.exit(1);
}

console.log(`startup lazy-import guard OK (${visited.size} eager modules reachable from cli.ts; gated modules absent)`);
