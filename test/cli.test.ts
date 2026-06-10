/**
 * CLI tests for the `jsmql` bin. These spawn `node src/cli.ts` directly —
 * exercising the real un-bundled source via Node's native type-stripping (the
 * same path the strippable-TS smoke test relies on), so no build step is
 * needed. The built `dist/cjs/cli.cjs` (shebang, exec bit, version `define`)
 * is covered separately by the dist-gated cases in smoke.test.ts.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Run the CLI with the given args and optional stdin; return {status, stdout, stderr}. */
function run(args: string[], input?: string) {
  const r = spawnSync(process.execPath, ["src/cli.ts", ...args], { cwd: ROOT, input: input ?? "", encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("cli: input sources", () => {
  it("reads JSMQL from stdin and prints MQL JSON (Filter default)", () => {
    const r = run([], "$.age > 18\n");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("accepts the source as a positional argument", () => {
    const r = run(["$.age > 18"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("reads the source from --file (in preference to stdin)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jsmql-cli-"));
    const file = join(dir, "query.jsmql");
    writeFileSync(file, "$.score >= 90\n");
    // stdin carries a different predicate to prove --file wins.
    const r = run(["--file", file], "$.age > 18");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ score: { $gte: 90 } });
  });
});

describe("cli: output shapes", () => {
  it("--filter forces a Filter document", () => {
    const r = run(["--filter", "$.age > 18"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("--pipeline forces a stage array", () => {
    const r = run(["--pipeline", "$match($.age > 18); $sort({ age: -1 })"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ $match: { age: { $gt: 18 } } }, { $sort: { age: -1 } }]);
  });

  it("--expr forces a raw aggregation expression", () => {
    const r = run(["--expr", "$.price * (1 - $.discount)"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ $multiply: ["$price", { $subtract: [1, "$discount"] }] });
  });

  it("--update forces an update pipeline", () => {
    const r = run(["--update", "$.name = $.name.toUpperCase()"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ $set: { name: { $toUpper: "$name" } } }]);
  });

  it("rejects a bare expression under --pipeline (inherited library error)", () => {
    const r = run(["--pipeline", "$.age > 18"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("jsmql: error:");
  });
});

describe("cli: formatting", () => {
  it("defaults to pretty (2-space, multiline) output", () => {
    const r = run(["$.age > 18"]);
    expect(r.stdout).toBe('{\n  "age": {\n    "$gt": 18\n  }\n}\n');
  });

  it("-c / --compact emits single-line JSON", () => {
    const r = run(["-c", "$.age > 18"]);
    expect(r.stdout).toBe('{"age":{"$gt":18}}\n');
  });

  it("--tab indents with tabs", () => {
    const r = run(["--tab", "$.age > 18"]);
    expect(r.stdout).toContain('\n\t"age"');
  });

  it("--indent N indents with N spaces", () => {
    const r = run(["--indent", "4", "$.age > 18"]);
    expect(r.stdout).toContain('\n    "age"');
  });
});

describe("cli: validate", () => {
  it("--validate prints {valid:true} and exits 0 for valid input", () => {
    const r = run(["--validate", "$.age > 18"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ valid: true, errors: [] });
  });

  it("--validate prints structured errors and exits 1 for invalid input", () => {
    const r = run(["--validate"], "$.age >");
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.valid).toBe(false);
    expect(out.errors[0]).toHaveProperty("pos");
    expect(out.errors[0]).toHaveProperty("message");
  });

  it("--check is an alias for --validate", () => {
    const r = run(["--check", "$.age > 18"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).valid).toBe(true);
  });
});

describe("cli: parameters", () => {
  it("--argjson binds a JSON value through jsmql.compile", () => {
    const r = run(["--argjson", "minAge", "18"], "({ minAge }, $) => $.age > minAge");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("--arg binds a string value", () => {
    const r = run(["--arg", "name", "ann"], "({ name }, $) => $.name === name");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ name: "ann" });
  });

  it("binds params under --filter (routes through jsmql.filter.compile)", () => {
    const r = run(["--filter", "--argjson", "minAge", "18"], "({ minAge }, $) => $.age > minAge");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("binds params under --pipeline and enforces the Pipeline shape", () => {
    const r = run(["--pipeline", "--argjson", "minAge", "18"], "({ minAge }, $) => { $match($.age > minAge) }");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("--pipeline + params rejects a bare-expression arrow (inherited shape error)", () => {
    const r = run(["--pipeline", "--argjson", "minAge", "18"], "({ minAge }, $) => $.age > minAge");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("jsmql.pipeline() expects a Pipeline");
  });

  it("binds params under --update and enforces the update-stage whitelist", () => {
    const r = run(["--update", "--argjson", "tier", "2"], "({ tier }, $) => ($.tier = tier)");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ $set: { tier: 2 } }]);
  });

  it("validates a parameterised arrow under --validate (exit 0 for valid)", () => {
    const r = run(["--validate", "--argjson", "minAge", "18"], "({ minAge }, $) => $.age > minAge");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ valid: true, errors: [] });
  });

  it("validates a parameterised arrow under --validate (exit 1 for invalid)", () => {
    const r = run(["--validate", "--argjson", "minAge", "18"], "({ minAge }, $) => $.age >");
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).valid).toBe(false);
  });

  it("reports invalid --argjson values as a usage error (exit 2)", () => {
    const r = run(["--argjson", "x", "{not json"], "({ x }, $) => $.v == x");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not valid JSON");
  });
});

describe("cli: errors and meta", () => {
  it("prints a compiler-style caret for a parse error (exit 1)", () => {
    const r = run([], "$.age >\n");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("jsmql: error:");
    expect(r.stderr).toContain("$.age >");
    expect(r.stderr).toContain("^");
  });

  it("rejects an unknown option with a usage error (exit 2)", () => {
    const r = run(["--nope", "$.age > 18"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown option '--nope'");
  });

  it("rejects two conflicting mode flags (exit 2)", () => {
    const r = run(["--filter", "--pipeline", "$.age > 18"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("conflicting");
  });

  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--pipeline");
  });
});
