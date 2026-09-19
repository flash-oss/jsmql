/**
 * CLI tests for the `jsmql` bin. These spawn `node src/cli.ts` directly. This
 * runs the real un-bundled source through Node's native type stripping (the
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
import * as mongodb from "mongodb";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Run the CLI with the given args and optional stdin; return {status, stdout, stderr}. */
function run(args: string[], input?: string) {
  const r = spawnSync(process.execPath, ["src/cli.ts", ...args], { cwd: ROOT, input: input ?? "", encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * The CLI writes JAVASCRIPT, so the output is read the way a developer reads it —
 * by pasting it somewhere that has the driver's BSON classes in scope. Evaluating
 * rather than parsing is itself the assertion the printer exists for: text the driver
 * would refuse fails here first.
 */
const BSON_GLOBALS: Record<string, unknown> = {
  ObjectId: mongodb.ObjectId,
  Decimal128: mongodb.Decimal128,
  Long: mongodb.Long,
  Int32: mongodb.Int32,
  Double: mongodb.Double,
  Binary: mongodb.Binary,
  UUID: mongodb.UUID,
  Timestamp: mongodb.Timestamp,
  MinKey: mongodb.MinKey,
  MaxKey: mongodb.MaxKey,
  Code: mongodb.Code,
  DBRef: mongodb.DBRef,
};
const asPasted = (text: string): unknown =>
  new Function(...Object.keys(BSON_GLOBALS), `return (${text})`)(...Object.values(BSON_GLOBALS));

describe("cli: input sources", () => {
  it("reads JSMQL from stdin and prints MQL JSON (Filter default)", () => {
    const r = run([], "$.age > 18\n");
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("accepts the source as a positional argument", () => {
    const r = run(["$.age > 18"]);
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("reads the source from --file (in preference to stdin)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jsmql-cli-"));
    const file = join(dir, "query.jsmql");
    writeFileSync(file, "$.score >= 90\n");
    // stdin carries a different predicate to prove --file wins.
    const r = run(["--file", file], "$.age > 18");
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ score: { $gte: 90 } });
  });
});

describe("cli: output shapes", () => {
  it("--filter forces a Filter document", () => {
    const r = run(["--filter", "$.age > 18"]);
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("--pipeline forces a stage array", () => {
    const r = run(["--pipeline", "$match($.age > 18); $sort({ age: -1 })"]);
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual([{ $match: { age: { $gt: 18 } } }, { $sort: { age: -1 } }]);
  });

  it("--expr forces a raw aggregation expression", () => {
    const r = run(["--expr", "$.price * (1 - $.discount)"]);
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ $multiply: ["$price", { $subtract: [1, "$discount"] }] });
  });

  it("--update forces an update document", () => {
    const r = run(["--update", "$.score += 1; delete $.tmp"]);
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ $inc: { score: 1 }, $unset: { tmp: "" } });
  });

  it("rejects a bare expression under --pipeline (inherited library error)", () => {
    const r = run(["--pipeline", "$.age > 18"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("jsmql: error:");
  });
});

describe("cli: formatting", () => {
  // The output is JAVASCRIPT, not JSON — a Date, an ObjectId, a Decimal128 and a regular
  // expression have no JSON spelling, and stringifying one is WRONG rather than lossy.
  // A document is written on one line while it fits in 80 columns and broken once it
  // does not, because MQL nests deeply and narrowly.
  it("writes a short document on one line", () => {
    expect(run(["$.age > 18"]).stdout).toBe("{ age: { $gt: 18 } }\n");
  });

  it("breaks a document that does not fit, one entry per line", () => {
    const r = run([
      '$.a === 1 && $.b === 2 && $.someLongerFieldName === "a value long enough that the one-line form passes eighty columns"',
    ]);
    expect(r.stdout).toBe(
      '{\n  a: 1,\n  b: 2,\n  someLongerFieldName: "a value long enough that the one-line form passes eighty columns"\n}\n',
    );
  });

  it("-c / --compact keeps the whole document on one line", () => {
    const src =
      '$.a === 1 && $.b === 2 && $.someLongerFieldName === "a value long enough that the one-line form passes eighty columns"';
    expect(run(["-c", src]).stdout).toBe(
      '{ a: 1, b: 2, someLongerFieldName: "a value long enough that the one-line form passes eighty columns" }\n',
    );
  });

  it("--tab and --indent N set the indent of a document that breaks", () => {
    const src =
      '$.a === 1 && $.b === 2 && $.someLongerFieldName === "a value long enough that the one-line form passes eighty columns"';
    expect(run(["--tab", src]).stdout).toContain("\n\ta: 1");
    expect(run(["--indent", "4", src]).stdout).toContain("\n    a: 1");
  });

  it("prints a live BSON value as the JavaScript that makes it", () => {
    expect(run(["-c", '$.d >= new Date("2026-01-01")']).stdout).toBe(
      '{ d: { $gte: new Date("2026-01-01T00:00:00.000Z") } }\n',
    );
    // `new` is not decoration: the driver's export is a class and the bare call throws.
    expect(run(["-c", '$._id === ObjectId("507f1f77bcf86cd799439011")']).stdout).toBe(
      '{ _id: new ObjectId("507f1f77bcf86cd799439011") }\n',
    );
    expect(run(["-c", "$.name.match(/^a/i)"]).stdout).toBe("{ name: { $regex: /^a/i } }\n");
  });

  // A quoted "__proto__" key sets the prototype when the text is pasted, so the field
  // would vanish on the way back in. The computed form is the only one that survives.
  it("writes a __proto__ key as a computed key", () => {
    expect(run(["-c", "$.__proto__ === 1"]).stdout).toBe('{ ["__proto__"]: 1 }\n');
    const back = asPasted(run(["-c", "$.__proto__ === 1"]).stdout) as Record<string, unknown>;
    expect(Object.hasOwn(back, "__proto__")).toBe(true);
    expect(back.__proto__).toBe(1);
  });
});

describe("cli: validate", () => {
  it("--validate prints {valid:true} and exits 0 for valid input", () => {
    const r = run(["--validate", "$.age > 18"]);
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ valid: true, errors: [] });
  });

  it("--validate prints structured errors and exits 1 for invalid input", () => {
    const r = run(["--validate"], "$.age >");
    expect(r.status).toBe(1);
    const out = asPasted(r.stdout);
    expect(out.valid).toBe(false);
    expect(out.errors[0]).toHaveProperty("pos");
    expect(out.errors[0]).toHaveProperty("message");
  });

  it("--check is an alias for --validate", () => {
    const r = run(["--check", "$.age > 18"]);
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout).valid).toBe(true);
  });
});

describe("cli: parameters", () => {
  it("--argjson binds a JSON value through jsmql.compile", () => {
    const r = run(["--argjson", "minAge", "18"], "({ minAge }, { $ }) => $.age > minAge");
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("--arg binds a string value", () => {
    const r = run(["--arg", "name", "ann"], "({ name }, { $ }) => $.name === name");
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ name: "ann" });
  });

  it("binds params under --filter (routes through jsmql.filter.compile)", () => {
    const r = run(["--filter", "--argjson", "minAge", "18"], "({ minAge }, { $ }) => $.age > minAge");
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ age: { $gt: 18 } });
  });

  it("binds params under --pipeline and enforces the Pipeline shape", () => {
    const r = run(["--pipeline", "--argjson", "minAge", "18"], "({ minAge }, { $ }) => { $match($.age > minAge) }");
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("--pipeline + params rejects a bare-expression arrow (inherited shape error)", () => {
    const r = run(["--pipeline", "--argjson", "minAge", "18"], "({ minAge }, { $ }) => $.age > minAge");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("jsmql.pipeline() expects a Pipeline");
  });

  it("binds params under --update into the update document", () => {
    const r = run(["--update", "--argjson", "tier", "2"], "({ tier }, { $ }) => ($.tier = tier)");
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ $set: { tier: 2 } });
  });

  it("validates a parameterised arrow under --validate (exit 0 for valid)", () => {
    const r = run(["--validate", "--argjson", "minAge", "18"], "({ minAge }, { $ }) => $.age > minAge");
    expect(r.status).toBe(0);
    expect(asPasted(r.stdout)).toEqual({ valid: true, errors: [] });
  });

  it("validates a parameterised arrow under --validate (exit 1 for invalid)", () => {
    const r = run(["--validate", "--argjson", "minAge", "18"], "({ minAge }, { $ }) => $.age >");
    expect(r.status).toBe(1);
    expect(asPasted(r.stdout).valid).toBe(false);
  });

  it("reports invalid --argjson values as a usage error (exit 2)", () => {
    const r = run(["--argjson", "x", "{not json"], "({ x }, { $ }) => $.v == x");
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
