#!/usr/bin/env node
/// <reference types="node" />
import { jsmql } from "./index.ts";
import { stringify } from "./stringify.ts";
import { readFileSync } from "node:fs";

declare const __JSMQL_VERSION__: string;
const VERSION: string = typeof __JSMQL_VERSION__ === "string" ? __JSMQL_VERSION__ : "0.0.0-dev";

const HELP = `jsmql — compile JSMQL source to MongoDB MQL JSON

Usage:
  jsmql [options] [source]

Reads JSMQL from the positional [source], --file, or stdin (in that order) and
writes MQL to stdout — JSON, and for a live BSON value (a Date, an ObjectId, a
regular expression) the JavaScript that makes it, so the output pastes into a
driver script. With no mode flag the output shape is dispatched the
same way the jsmql() library call does (a top-level ';' makes it a Pipeline).

Output shape (default: polymorphic):
  --filter        force a Filter document   (single object)
  --pipeline      force a Pipeline           (array of stages)
  --expr          force an aggregation expression
  --update        force an update document   (the object updateOne takes)
  --validate      report {valid, errors} as JSON; exit 1 if invalid
  --check         alias for --validate

Output format (default: pretty, 2-space):
  -c, --compact   the whole document on one line
      --tab       indent with tabs
      --indent N  indent with N spaces (0-10)

Input:
  -f, --file PATH read source from PATH instead of stdin/positional

Parameters (the source must be a parameterised arrow, for example
'({ minAge }, { $ }) => $.age > minAge'; combine with any output-shape flag above):
      --arg NAME VALUE      bind NAME to the string VALUE
      --argjson NAME VALUE  bind NAME to the JSON-parsed VALUE

Meta:
  -h, --help      show this help
      --version   print the jsmql version

Examples:
  echo '$.age > 18' | jsmql
  echo '$.age > 18; $sort({ age: -1 })' | jsmql --pipeline
  echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --argjson minAge 18
  echo '({ minAge }, { $ }) => { $match($.age > minAge) }' | jsmql --pipeline --argjson minAge 18
`;

type Mode = "auto" | "filter" | "pipeline" | "expr" | "update" | "validate";

type Options = {
  mode: Mode;
  indent: number | string;
  width: number;
  params: Map<string, unknown>;
  hasParams: boolean;
  help: boolean;
  version: boolean;
  source?: string;
  file?: string;
};

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
  const opts: Options = {
    mode: "auto",
    indent: 2,
    width: 80,
    params: new Map(),
    hasParams: false,
    help: false,
    version: false,
  };
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
    else if (a === "-c" || a === "--compact") opts.width = Infinity;
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
      opts.params.set(name, requireValue(argv[i], "--arg"));
      opts.hasParams = true;
    } else if (a === "--argjson") {
      i++;
      const name = requireValue(argv[i], "--argjson");
      i++;
      opts.params.set(name, parseJsonArg(name, requireValue(argv[i], "--argjson")));
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
  return readFileSync(0, "utf8");
}

function compile(mode: Mode, source: string, params: Record<string, unknown> | undefined): unknown {
  if (params) {
    if (mode === "filter") return jsmql.filter.compile(source)(params);
    if (mode === "pipeline") return jsmql.pipeline.compile(source)(params);
    if (mode === "expr") return jsmql.expr.compile(source)(params);
    if (mode === "update") return jsmql.update.compile(source)(params);
    return jsmql.compile(source)(params);
  }
  if (mode === "filter") return jsmql.filter(source);
  if (mode === "pipeline") return jsmql.pipeline(source);
  if (mode === "expr") return jsmql.expr(source);
  if (mode === "update") return jsmql.update(source);
  return jsmql(source);
}

function renderError(err: unknown): string {
  const message = typeof (err as { message?: unknown }).message === "string" ? (err as Error).message : String(err);
  return `jsmql: error: ${message}\n`;
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
    source = resolveSource(opts).trimEnd();
  } catch (err) {
    if (err instanceof UsageError) return usageExit(err.message);
    throw err;
  }

  try {
    if (opts.mode === "validate") {
      const result = jsmql.validate(source);
      const report = opts.width === Infinity ? JSON.stringify(result) : JSON.stringify(result, null, opts.indent);
      process.stdout.write(report + "\n");
      return result.valid ? 0 : 1;
    }
    const params = opts.hasParams ? Object.fromEntries(opts.params) : undefined;
    const result = compile(opts.mode, source, params);
    process.stdout.write(stringify(result, { indent: opts.indent, width: opts.width }) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(renderError(err));
    return 1;
  }
}

process.exitCode = main();
