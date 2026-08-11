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

  // A param the server can't spell as a `$$` variable has to be escaped at the call
  // site's $let too, not just in the array-method binding sites — MongoDB rejects
  // "'_' starts with an invalid character for a user variable name".
  it("a param name the server rejects is escaped at the call site", () => {
    expect(jsmql.expr("((_) => 1)(2)")).toEqual({ $let: { vars: { v_: 2 }, in: 1 } });
    expect(jsmql("const f = (_, n) => n + 1; $.y = f($.a, $.b);")).toEqual([
      { $set: { y: { $let: { vars: { v_: "$a", n: "$b" }, in: { $add: ["$$n", 1] } } } } },
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

  it("a lone `function` declaration (nothing calls it) is rejected like a lone arrow decl", () => {
    expect(() => jsmql("function foo(a) { return a }")).toThrow(/only valid inside a pipeline/);
  });

  it("a `function` declaration with local bindings used as a query predicate is rejected with guidance", () => {
    expect(() =>
      jsmql("const r = $$$.tags.find(function (t) { const a = t.score; return a > 5 }); $ = { r };"),
    ).toThrow(/predicate has local `const`\/`let` bindings/);
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
  it("a function declared in an .aggregate block lambda closes over the foreign param", () => {
    // `u.age` inside the function body must hoist to "$age" in the $lookup
    // sub-pipeline, exactly like a `let` would (the function is a named IIFE).
    expect(
      jsmql("$.users = $$$.users.aggregate(u => { const score = () => u.age * 2; $match(score() > 100); });"),
    ).toEqual([
      {
        $lookup: {
          from: "users",
          pipeline: [{ $match: { $expr: { $gt: [{ $let: { vars: {}, in: { $multiply: ["$age", 2] } } }, 100] } } }],
          as: "users",
        },
      },
    ]);
  });

  it("a `function`-keyword declaration lowers identically to the `const = arrow` form (DEF-030 success criteria)", () => {
    const fnForm = jsmql("function double(x) { return x * 2 } $ = { a: double($.price) };");
    const arrowForm = jsmql("const double = (x) => x * 2; $ = { a: double($.price) };");
    expect(fnForm).toEqual(arrowForm);
    // …and the self-terminating form (no `;` after `}`) is valid too.
    expect(jsmql("function double(x) { return x * 2 } $ = { a: double($.price) }")).toEqual(arrowForm);
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

// The `function` keyword: a second spelling of the reusable-function/arrow
// surface, accepted everywhere arrows are (declaration, inline callback, IIFE,
// entry form). Each case asserts byte-identical MQL to the arrow equivalent.
// See docs/specs/reusable-functions.md § The `function` keyword.
describe("`function` keyword — parity with the arrow form", () => {
  it("declaration form lowers identically to `const f = (x) => …`", () => {
    const arrow = jsmql("const double = (x) => x * 2; $ = { a: double($.price) };");
    expect(jsmql("function double(x) { return x * 2 } $ = { a: double($.price) };")).toEqual(arrow);
  });

  it("is self-terminating — no `;` needed after the closing `}`", () => {
    const withSemi = jsmql("function double(x) { return x * 2 }; $ = { a: double($.price) };");
    const noSemi = jsmql("function double(x) { return x * 2 } $ = { a: double($.price) }");
    expect(noSemi).toEqual(withSemi);
  });

  it("a self-terminating chain of declarations composes", () => {
    const fn = jsmql("function inc(x) { return x + 1 } function dbl(x) { return x * 2 } $ = { a: dbl(inc($.n)) }");
    const arrow = jsmql("const inc = (x) => x + 1; const dbl = (x) => x * 2; $ = { a: dbl(inc($.n)) };");
    expect(fn).toEqual(arrow);
  });

  it("an anonymous `function` expression works as an inline `.map` callback", () => {
    const arrow = jsmql.expr("$.items.map((x) => x * 2)");
    expect(jsmql.expr("$.items.map(function (x) { return x * 2 })")).toEqual(arrow);
  });

  it("a NAMED `function` expression callback ignores the name", () => {
    const anon = jsmql.expr("$.items.map(function (x) { return x * 2 })");
    expect(jsmql.expr("$.items.map(function scale(x) { return x * 2 })")).toEqual(anon);
  });

  it("a `function` body with local `const`/`let` lowers to nested `$let` (≡ block-body arrow)", () => {
    const arrow = jsmql.expr("$.items.map((x) => { const y = x + 1; return y * 2 })");
    expect(jsmql.expr("$.items.map(function (x) { const y = x + 1; return y * 2 })")).toEqual(arrow);
  });

  it("a parenthesised `function` IIFE lowers to `$let` (≡ the arrow IIFE)", () => {
    const arrow = jsmql.expr("((x) => x * 2)(5)");
    expect(jsmql.expr("(function (x) { return x * 2 })(5)")).toEqual(arrow);
  });

  it("`function` declaration works as a bracketed-pipeline element", () => {
    const fn = jsmql("[ function double(x) { return x * 2 }, $set({ a: double($.price) }) ]");
    const arrow = jsmql("[ const double = (x) => x * 2, $set({ a: double($.price) }) ]");
    expect(fn).toEqual(arrow);
  });

  it("works inside a `$$$.<coll>.find` predicate (expression body) like an arrow", () => {
    const fn = jsmql("const tags = $$$.tags.find(function (t) { return t.active }); $ = { tags };");
    const arrow = jsmql("const tags = $$$.tags.find((t) => t.active); $ = { tags };");
    expect(fn).toEqual(arrow);
  });

  it("entry form `jsmql(function ({ $ }) { return … })` lowers like the arrow entry", () => {
    expect(
      jsmql(function ({ $ }) {
        return $.age >= 18;
      }),
    ).toEqual(jsmql(({ $ }) => $.age >= 18));
  });

  it("`jsmql.compile(function (params, { $ }) { return … })` lowers like the arrow compile form", () => {
    const fn = jsmql.compile(function ({ min }, { $ }) {
      return $.age >= min;
    });
    const arrow = jsmql.compile(({ min }, { $ }) => $.age >= min);
    expect(fn({ min: 21 })).toEqual(arrow({ min: 21 }));
  });

  // The arrow entry form is `({ $ }) => …` (a single destructured toolbox). The
  // old positional shapes — a bare `$`, a bare doc identifier, the two-slot
  // `($, { $op })`, and the three-slot `(params, $, { $op })` — are rejected.
  // (String inputs route through the same `parseFunctionInput` path as live
  // arrows without tripping the toolbox param type in this .ts file.)
  it("rejects the old bare-`$` arrow entry form `($) => …`", () => {
    expect(() => jsmql.compile("($) => $.age > 18")).toThrow(/object destructure pattern/);
  });

  it("rejects a bare-identifier doc parameter `(doc) => …`", () => {
    expect(() => jsmql.compile("(doc) => doc.age > 18")).toThrow(/object destructure pattern/);
  });

  it("rejects the old two-slot ops-hint form `($, { $op }) => …`", () => {
    expect(() => jsmql.compile("($, { $dateDiff }) => $.age > 18")).toThrow(/object destructure pattern/);
  });

  it("rejects the old three-slot compile form `(params, $, { $op }) => …`", () => {
    expect(() => jsmql.compile("({ minAge }, $, { $match }) => $.age > minAge")).toThrow(/object destructure pattern/);
  });

  it("rejects the old `function ($) { … }` entry form", () => {
    expect(() => jsmql.compile("function ($) { return $.age > 18 }")).toThrow(/object destructure pattern/);
  });

  it("accepts the bare `$` plus context refs `$$` / `$$$` / `$$$$` as toolbox keys", () => {
    expect(jsmql.compile("({ $, $$, $$$, $$$$ }) => $.age > 18")()).toEqual({ age: { $gt: 18 } });
  });

  it("rejects mixing params and toolbox keys in one destructure", () => {
    expect(() => jsmql.compile("({ minAge, $ }) => $.age > minAge")).toThrow(/separate|toolbox destructure/);
  });

  it("rejects a third parameter slot", () => {
    expect(() => jsmql.compile("({ minAge }, { $ }, { $match }) => $.age > minAge")).toThrow(/at most two parameters/);
  });

  it("rejects the toolbox destructure before params", () => {
    expect(() => jsmql.compile("({ $ }, { minAge }) => $.age > minAge")).toThrow(
      /params destructure to appear before the toolbox/,
    );
  });

  it("rejects a generator `function*` with an actionable message", () => {
    expect(() => jsmql("function* f(x) { return x } $ = { a: f($.n) }")).toThrow(/generator functions/);
  });

  it("`function` is not a reserved keyword — object keys and field paths keep working", () => {
    // It lexes as an ordinary identifier and is intercepted only where a function
    // expression/declaration can actually start, so `{ function: … }` (object
    // key) and `$.function` (field path) are unaffected.
    expect(jsmql.expr("{ function: $.x }")).toEqual({ function: "$x" });
    expect(jsmql.expr("$.function")).toEqual("$function");
  });
});
