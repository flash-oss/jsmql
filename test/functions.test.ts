import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// Reusable named functions: `const f = (a) => …` declared at the top of a
// pipeline, expanded INLINE at each call site as an IIFE → `$let` (re-lowered
// per call, never hoisted). See docs/specs/reusable-functions.md.

describe("reusable functions — declaration + call", () => {
  it("two call sites each re-lower to their own $let (Fact 3)", () => {
    expect(jsmql("const double = (x) => x * 2; $ = { a: double($.price), b: double($.cost) };")).toEqual([
      {
        $replaceWith: {
          a: { $let: { vars: { x: "$price" }, in: { $multiply: ["$$x", 2] } } },
          b: { $let: { vars: { x: "$cost" }, in: { $multiply: ["$$x", 2] } } },
        },
      },
    ]);
  });

  it("unparenthesized single-param arrow RHS (`const f = x => …`)", () => {
    expect(jsmql("const double = x => x * 2; $ = { a: double($.price) };")).toEqual([
      { $replaceWith: { a: { $let: { vars: { x: "$price" }, in: { $multiply: ["$$x", 2] } } } } },
    ]);
  });

  it("multi-param function binds every param", () => {
    expect(jsmql("const between = (lo, hi) => $.age >= lo && $.age <= hi; $ = { ok: between(18, 65) };")).toEqual([
      {
        $replaceWith: {
          ok: {
            $let: { vars: { lo: 18, hi: 65 }, in: { $and: [{ $gte: ["$age", "$$lo"] }, { $lte: ["$age", "$$hi"] }] } },
          },
        },
      },
    ]);
  });

  it("zero-param function lowers to an empty-vars $let (server-valid, like a 0-arg IIFE)", () => {
    expect(jsmql("const pi = () => 3.14; $ = { x: pi() };")).toEqual([
      { $replaceWith: { x: { $let: { vars: {}, in: 3.14 } } } },
    ]);
  });

  it("`let`-kind declaration is also a function", () => {
    expect(jsmql("let double = (x) => x * 2; $ = { a: double($.p) };")).toEqual([
      { $replaceWith: { a: { $let: { vars: { x: "$p" }, in: { $multiply: ["$$x", 2] } } } } },
    ]);
  });

  it("block-body with a local `const` nests $let in source order", () => {
    expect(jsmql("const f = (a) => { const t = a * 2; return t + 1; }; $ = { v: f($.n) };")).toEqual([
      {
        $replaceWith: {
          v: {
            $let: {
              vars: { a: "$n" },
              in: { $let: { vars: { t: { $multiply: ["$$a", 2] } }, in: { $add: ["$$t", 1] } } },
            },
          },
        },
      },
    ]);
  });

  it("body may close over the root document (free `$.field` ref)", () => {
    expect(jsmql("const withTax = (p) => p * $.rate; $ = { net: withTax($.gross) };")).toEqual([
      { $replaceWith: { net: { $let: { vars: { p: "$gross" }, in: { $multiply: ["$$p", "$rate"] } } } } },
    ]);
  });

  it("a function may call an earlier-declared function (inline composition)", () => {
    expect(jsmql("const inc = (x) => x + 1; const incTwice = (n) => inc(inc(n)); $ = { v: incTwice($.k) };")).toEqual([
      {
        $replaceWith: {
          v: {
            $let: {
              vars: { n: "$k" },
              in: {
                $let: {
                  vars: { x: { $let: { vars: { x: "$$n" }, in: { $add: ["$$x", 1] } } } },
                  in: { $add: ["$$x", 1] },
                },
              },
            },
          },
        },
      },
    ]);
  });
});

describe("reusable functions — call sites in various contexts", () => {
  it("inside a `$set` RHS", () => {
    expect(jsmql("const t = (x) => x * 1.1; $.total = t($.amount);")).toEqual([
      { $set: { total: { $let: { vars: { x: "$amount" }, in: { $multiply: ["$$x", 1.1] } } } } },
    ]);
  });

  it("inside a `.map()` lambda — the lambda param is the argument", () => {
    expect(jsmql("const double = (x) => x * 2; $ = { ys: $.xs.map(n => double(n)) };")).toEqual([
      {
        $replaceWith: {
          ys: { $map: { input: "$xs", as: "n", in: { $let: { vars: { x: "$$n" }, in: { $multiply: ["$$x", 2] } } } } },
        },
      },
    ]);
  });

  it("inside a `$match` lowers via $expr", () => {
    expect(jsmql("const isBig = (a) => a > 100; $match(isBig($.amount));")).toEqual([
      { $match: { $expr: { $let: { vars: { a: "$amount" }, in: { $gt: ["$$a", 100] } } } } },
    ]);
  });

  it("template-tag form: interpolated arg becomes a bound var", () => {
    expect(jsmql`const double = (x) => x * 2; $ = { a: double(${5}), b: double($.cost) };`).toEqual([
      {
        $replaceWith: {
          a: { $let: { vars: { x: 5 }, in: { $multiply: ["$$x", 2] } } },
          b: { $let: { vars: { x: "$cost" }, in: { $multiply: ["$$x", 2] } } },
        },
      },
    ]);
  });
});

describe("reusable functions — output stability", () => {
  it("a declared-but-uncalled function emits no stage and no namespace", () => {
    // Byte-identical to the same pipeline without the declaration: a function
    // declaration is erased unless called.
    expect(jsmql("const unused = (x) => x; $.y = $.z + 1;")).toEqual(jsmql("$.y = $.z + 1;"));
    expect(jsmql("const unused = (x) => x; $.y = $.z + 1;")).toEqual([{ $set: { y: { $add: ["$z", 1] } } }]);
  });

  it("works as a bracketed-pipeline element", () => {
    expect(jsmql("[const double = (x) => x * 2, $set({ y: double($.x) })]")).toEqual([
      { $set: { y: { $let: { vars: { x: "$x" }, in: { $multiply: ["$$x", 2] } } } } },
    ]);
  });
});

describe("reusable functions — rejections (actionable errors)", () => {
  it("arity mismatch names the params", () => {
    expect(() => jsmql("const add = (a, b) => a + b; $ = { s: add($.x) };")).toThrow(
      /Function 'add': expected 2 argument\(s\) for params \(a, b\), got 1/,
    );
  });

  it("direct recursion is rejected", () => {
    expect(() => jsmql("const f = (x) => f(x) + 1; $ = { a: f($.n) };")).toThrow(
      /Recursive function calls aren't supported/,
    );
  });

  it("mutual recursion is rejected", () => {
    expect(() => jsmql("const a = (x) => b(x); const b = (y) => a(y); $ = { r: a($.n) };")).toThrow(
      /Recursive function calls aren't supported/,
    );
  });

  it("unknown function suggests the closest declared name", () => {
    expect(() => jsmql("const compute = (x) => x; $ = { a: comput($.n) };")).toThrow(
      /Unknown function 'comput\(\.\.\.\)'\. Did you mean 'compute\(\.\.\.\)'\?/,
    );
  });

  it("a function used as a value (not called) is rejected (higher-order use)", () => {
    expect(() => jsmql("const double = (x) => x * 2; $ = { f: double };")).toThrow(
      /'double' is a reusable function — call it with 'double\(\.\.\.\)'/,
    );
  });

  it("the `function` keyword is redirected to the arrow form", () => {
    expect(() => jsmql("function foo(a) { return a; } $ = { x: foo($.n) };")).toThrow(
      /The `function` keyword isn't supported here — declare a reusable function with an arrow/,
    );
  });

  it("re-declaring a function in the same pipeline is rejected", () => {
    expect(() => jsmql("const f = (x) => x; const f = (y) => y + 1; $ = { a: f($.n) };")).toThrow(
      /Function `f` is already declared earlier in this pipeline/,
    );
  });

  it("a function name colliding with a `let` binding is rejected", () => {
    expect(() => jsmql("let total = $.amount; const total = (x) => x; $ = { a: total($.n) };")).toThrow(
      /Function `total` collides with a `let total` binding/,
    );
  });

  it("a nested function inside an arrow body is rejected", () => {
    expect(() => jsmql("$ = { a: $.xs.map(x => { const g = z => z + 1; return g(x); }) };")).toThrow(
      /Reusable functions must be declared at the top level of a pipeline/,
    );
  });

  it("a function declaration with no pipeline (no `;`) is rejected", () => {
    expect(() => jsmql("const f = (x) => x * 2")).toThrow(
      /A reusable function declaration .* is only valid inside a pipeline/,
    );
  });
});

describe("reusable functions — validate() carries a meaningful .pos", () => {
  it("recursion error has a real position", () => {
    const res = jsmql.validate("const f = (x) => f(x) + 1; $ = { a: f($.n) };");
    expect(res.valid).toBe(false);
    expect(res.errors[0].pos).toBeGreaterThan(0);
    expect(res.errors[0].message).toMatch(/Recursive function calls aren't supported/);
  });

  it("arity error has a real position", () => {
    const res = jsmql.validate("const add = (a, b) => a + b; $ = { s: add($.x) };");
    expect(res.valid).toBe(false);
    expect(res.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("reusable functions — review-driven hardening", () => {
  it("a function declared in a $lookup block lambda closes over the foreign param", () => {
    // `u.age` inside the function body must hoist to "$age" in the $lookup
    // sub-pipeline, exactly like a `let` would (the function is a named IIFE).
    expect(jsmql("$.user = $$$.users.find(u => { const score = () => u.age * 2; $match(score() > 100); });")).toEqual([
      {
        $lookup: {
          from: "users",
          let: {},
          pipeline: [{ $match: { $expr: { $gt: [{ $let: { vars: {}, in: { $multiply: ["$age", 2] } } }, 100] } } }],
          as: "user",
        },
      },
      { $set: { user: { $first: "$user" } } },
    ]);
  });

  it("the `function`-keyword redirect surfaces identically via validate() and jsmql()", () => {
    const src = "function foo(a) { return a; } $ = { x: foo($.n) };";
    const res = jsmql.validate(src);
    expect(res.valid).toBe(false);
    expect(res.errors[0].pos).toBe(0);
    expect(res.errors[0].message).toMatch(/The `function` keyword isn't supported here — declare a reusable function/);
    // jsmql() throws the same message (no divergence between the two surfaces).
    expect(() => jsmql(src)).toThrow(res.errors[0].message);
  });

  it("a reusable function passed as a bare array-method callback names it and suggests the wrap", () => {
    expect(() => jsmql("const double = (x) => x * 2; $ = { a: $.items.map(double) };")).toThrow(
      /\.map\(\) got the reusable function 'double' as a bare callback — pass a lambda that calls it: `\.map\(x => double\(x\)\)`/,
    );
  });

  it("a non-function bare callback still gets the generic lambda-required error", () => {
    expect(() => jsmql("$ = { a: $.items.map(5) };")).toThrow(/\.map\(\) requires a lambda as its first argument/);
  });
});
