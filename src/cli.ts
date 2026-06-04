#!/usr/bin/env node
// The `jsmql` command — a `jq`-style transpiler: JSMQL source in (positional
// arg / --file / stdin), MQL JSON out (stdout). A thin wrapper over the public
// API in ./index.ts — every shape it can emit already exists there as an
// entry point, so there is no compilation logic here, only argument routing,
// output formatting, and compiler-style error rendering.
//
// This file stays in TypeScript's strippable subset (see src/CLAUDE.md) and
// carries a classic Node shebang. esbuild bundles it to dist/cjs/cli.cjs
// (Node 14 target, shebang preserved) which package.json#bin maps to `jsmql`.
// Pull @types/node into scope for tsc only: this is the one src/ file that
// touches Node globals (`process`) and the `node:` builtins, and the project's
// tsconfig intentionally omits node types from the default src build. The
// directive is a comment, so the native type-stripper, esbuild, and Node all
// ignore it at runtime.
/// <reference types="node" />
import { jsmql } from "./index.ts";
import { readFileSync } from "node:fs";

// Replaced at build time by esbuild `define` (scripts/build-cjs.mjs) with the
// package.json version. The `typeof` guard keeps the un-bundled `node
// src/cli.ts` run (where the identifier is genuinely undefined) from throwing.
declare const __JSMQL_VERSION__: string;
const VERSION: string = typeof __JSMQL_VERSION__ === "string" ? __JSMQL_VERSION__ : "0.0.0-dev";

const HELP = `jsmql — compile JSMQL source to MongoDB MQL JSON

Usage:
  jsmql [options] [source]

Reads JSMQL from the positional [source], --file, or stdin (in that order) and
writes MQL JSON to stdout. With no mode flag the output shape is dispatched the
same way the jsmql() library call does (a top-level ';' makes it a Pipeline).

Output shape (default: polymorphic):
  --filter        force a Filter document   (single object)
  --pipeline      force a Pipeline           (array of stages)
  --expr          force an aggregation expression
  --update        force an update pipeline   (whitelisted stages)
  --validate      report {valid, errors} as JSON; exit 1 if invalid
  --check         alias for --validate

Formatting (default: pretty, 2-space):
  -c, --compact   single-line minified JSON
      --tab       indent with tabs
      --indent N  indent with N spaces (0-10)

Input:
  -f, --file PATH read source from PATH instead of stdin/positional

Parameters (route through jsmql.compile — the source must be a parameterised
arrow, e.g. '({ minAge }, $) => $.age > minAge'):
      --arg NAME VALUE      bind NAME to the string VALUE
      --argjson NAME VALUE  bind NAME to the JSON-parsed VALUE

Meta:
  -h, --help      show this help
      --version   print the jsmql version

Examples:
  echo '$.age > 18' | jsmql
  echo '$.age > 18; $sort({ age: -1 })' | jsmql --pipeline
  echo '({ minAge }, $) => $.age > minAge' | jsmql --argjson minAge 18
`;

type Mode = "auto" | "filter" | "pipeline" | "expr" | "update" | "validate";

type Options = {
  mode: Mode;
  // `number` → that many spaces; `"\t"` → tabs; 0 → compact. Passed straight to
  // JSON.stringify's third argument.
  indent: number | string;
  params: Record<string, unknown>;
  hasParams: boolean;
  help: boolean;
  version: boolean;
  source?: string;
  file?: string;
};

// Thrown for command-line mistakes (unknown/conflicting flags, a missing value,
// no input on a TTY). Distinct from a compile error so main() can map it to
// exit code 2 instead of 1.
class UsageError extends Error {}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`option '${flag}' requires a value.`);
  return v;
}

function parseIndent(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    throw new UsageError(`--indent expects an integer between 0 and 10, got '${v}'.`);
  }
  return n;
}

function parseJsonArg(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`--argjson ${name}: value is not valid JSON — ${raw}`);
  }
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { mode: "auto", indent: 2, params: {}, hasParams: false, help: false, version: false };
  const setMode = (m: Mode): void => {
    if (opts.mode !== "auto") {
      throw new UsageError(`conflicting output-shape flags: --${opts.mode} and --${m}. Pick one.`);
    }
    opts.mode = m;
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--version") opts.version = true;
    else if (a === "--filter") setMode("filter");
    else if (a === "--pipeline") setMode("pipeline");
    else if (a === "--expr") setMode("expr");
    else if (a === "--update") setMode("update");
    else if (a === "--validate" || a === "--check") setMode("validate");
    else if (a === "-c" || a === "--compact") opts.indent = 0;
    else if (a === "--tab") opts.indent = "\t";
    else if (a === "--indent") {
      i++;
      opts.indent = parseIndent(requireValue(argv[i], "--indent"));
    } else if (a === "-f" || a === "--file") {
      i++;
      opts.file = requireValue(argv[i], "--file");
    } else if (a === "--arg") {
      i++;
      const name = requireValue(argv[i], "--arg");
      i++;
      opts.params[name] = requireValue(argv[i], "--arg");
      opts.hasParams = true;
    } else if (a === "--argjson") {
      i++;
      const name = requireValue(argv[i], "--argjson");
      i++;
      opts.params[name] = parseJsonArg(name, requireValue(argv[i], "--argjson"));
      opts.hasParams = true;
    } else if (a.length > 1 && a[0] === "-") {
      throw new UsageError(`unknown option '${a}'.`);
    } else {
      if (opts.source !== undefined) {
        throw new UsageError(`unexpected extra argument '${a}'. Provide a single source, or use --file.`);
      }
      opts.source = a;
    }
    i++;
  }
  return opts;
}

function resolveSource(opts: Options): string {
  if (opts.source !== undefined) return opts.source;
  if (opts.file !== undefined) return readFileSync(opts.file, "utf8");
  if (process.stdin.isTTY) {
    throw new UsageError("no input — pass a source argument, --file <path>, or pipe JSMQL on stdin.");
  }
  // fd 0 = stdin; the synchronous read keeps the CLI dependency-free and
  // Node-14 compatible (no streams, no util.parseArgs).
  return readFileSync(0, "utf8");
}

function compile(mode: Mode, source: string): unknown {
  if (mode === "filter") return jsmql.filter(source);
  if (mode === "pipeline") return jsmql.pipeline(source);
  if (mode === "expr") return jsmql.expr(source);
  if (mode === "update") return jsmql.update(source);
  return jsmql(source);
}

// Compiler-style error output: the message, then the offending source line with
// a caret under the column derived from the error's `.pos`. Every jsmql compile
// error (LexError / ParseError / CodegenError / UnknownIdentifierError /
// FunctionInputError) carries `pos: number`; when it is absent we print the
// message alone.
function renderError(err: unknown, source: string): string {
  const e = err as { message?: string; pos?: number };
  const message = typeof e.message === "string" ? e.message : String(err);
  let out = `jsmql: error: ${message}\n`;
  const pos = typeof e.pos === "number" ? e.pos : -1;
  if (pos >= 0 && pos <= source.length && source.length > 0) {
    const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
    const nl = source.indexOf("\n", pos);
    const lineEnd = nl === -1 ? source.length : nl;
    const lineText = source.slice(lineStart, lineEnd);
    const col = pos - lineStart;
    out += `  ${lineText}\n  ${" ".repeat(col)}^\n`;
  }
  return out;
}

function usageExit(message: string): number {
  process.stderr.write(`jsmql: ${message}\nTry 'jsmql --help'.\n`);
  return 2;
}

function main(): number {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) return usageExit(err.message);
    throw err;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }

  let source: string;
  try {
    // [DEF-028] Params (--arg/--argjson) route through jsmql.compile(), which
    // the strict-shape entries and the structured validate() path don't expose.
    // Rejecting the combination beats silently ignoring the bound values.
    if (opts.hasParams && opts.mode !== "auto") {
      throw new UsageError(
        `parameters (--arg/--argjson) work only with the default output shape, not --${opts.mode}. ` +
          "Drop the mode flag, or bind the values directly into the arrow body.",
      );
    }
    // Trailing whitespace (notably the newline a shell `echo`/heredoc appends)
    // is insignificant to the language; trimming it keeps an end-of-input
    // error's caret on the source line instead of a dangling blank one.
    source = resolveSource(opts).trimEnd();
  } catch (err) {
    if (err instanceof UsageError) return usageExit(err.message);
    throw err;
  }

  try {
    if (opts.mode === "validate") {
      const result = jsmql.validate(source);
      process.stdout.write(JSON.stringify(result, null, opts.indent) + "\n");
      return result.valid ? 0 : 1;
    }
    const result = opts.hasParams ? jsmql.compile(source)(opts.params) : compile(opts.mode, source);
    process.stdout.write(JSON.stringify(result, null, opts.indent) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(renderError(err, source));
    return 1;
  }
}

process.exitCode = main();
