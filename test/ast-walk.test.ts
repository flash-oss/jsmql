// test/ast-walk.test.ts — the traversal table is complete AND correct.
//
// TypeScript already forces an ENTRY for every `Expr` kind (`Record<Expr["type"], …>`),
// so a new node kind cannot be added without declaring its children. That guarantees
// presence, not correctness: an entry naming the wrong field, or missing one of a node's
// several child slots, type-checks perfectly and silently hides a sub-tree.
//
// So each case below buries a marker in ONE child slot and asserts the walk reaches it.
// A slot the table forgets makes its case fail.

import { describe, expect, it } from "vitest";
import { Parser } from "../src/parser.ts";
import { someExpr, flattenExpr } from "../src/ast-walk.ts";
import type { Expr } from "../src/ast.ts";

/** A marker no other part of the source can produce. */
const MARK = "__walk_marker__";
const hasMarker = (e: Expr): boolean => e.type === "FieldRef" && e.path === MARK;

function parseExpr(src: string): Expr {
  return new Parser(src).parse() as Expr;
}

// One case per child slot in the table. The marker sits in exactly that slot.
const SLOTS: [string, string][] = [
  ["MethodCall.object", `$.${MARK}.trim()`],
  ["MethodCall.args", `$.s.startsWith($.${MARK})`],
  ["CallExpression.args", `f($.${MARK})`],
  ["OperatorCall.args", `$abs($.${MARK})`],
  ["MathCall.args", `Math.abs($.${MARK})`],
  ["ObjectCall.args", `Object.keys($.${MARK})`],
  ["MemberAccess.object", `$.${MARK}.a`],
  ["IndexAccess.object", `$.${MARK}[0]`],
  ["IndexAccess.index", `$.a[$.${MARK}]`],
  ["BinaryExpr.left", `$.${MARK} + 1`],
  ["BinaryExpr.right", `1 + $.${MARK}`],
  ["UnaryExpr.operand", `!$.${MARK}`],
  ["TernaryExpr.condition", `$.${MARK} ? 1 : 2`],
  ["TernaryExpr.consequent", `$.c ? $.${MARK} : 2`],
  ["TernaryExpr.alternate", `$.c ? 1 : $.${MARK}`],
  ["TemplateLiteral.expressions", "`a${$." + MARK + "}b`"],
  ["ArrayLiteral.elements", `[1, $.${MARK}]`],
  ["ArrayLiteral spread", `[...$.${MARK}]`],
  ["ObjectLiteral.value", `({ a: $.${MARK} })`],
  ["ObjectLiteral computed key", `({ [$.${MARK}]: 1 })`],
  ["ObjectLiteral spread", `({ ...$.${MARK} })`],
  ["Lambda.body", `$.a.map(x => $.${MARK})`],
  ["Lambda.exprBlock decl", `$.a.map(x => { const q = $.${MARK}; return q; })`],
  ["Lambda.exprBlock ret", `$.a.map(x => { const q = 1; return $.${MARK}; })`],
  ["TypeofExpr.operand", `typeof $.${MARK}`],
  ["TypeCast.arg", `Number($.${MARK})`],
  ["NewDate.args", `new Date($.${MARK})`],
  ["NewSet.arg", `new Set($.${MARK})`],
  ["ArrayFrom.input", `Array.from($.${MARK})`],
  ["ArrayFrom.mapFn", `Array.from($.a, x => $.${MARK})`],
  ["NumberStatic.arg", `Number.isInteger($.${MARK})`],
  ["DateUTC.args", `Date.UTC($.${MARK}, 1, 1)`],
];

describe("the traversal table reaches every child slot", () => {
  for (const [slot, src] of SLOTS) {
    it(`finds a marker in ${slot}`, () => {
      const ast = parseExpr(src);
      expect(someExpr(ast, hasMarker), `no walk reached the marker in ${slot} — check its CHILDREN entry`).toBe(true);
    });
  }
});

describe("the walk terminates and covers", () => {
  it("visits the root itself", () => {
    expect(someExpr(parseExpr(`$.${MARK}`), hasMarker)).toBe(true);
  });

  it("returns false when the marker is absent", () => {
    expect(someExpr(parseExpr("$.a.trim().toUpperCase()"), hasMarker)).toBe(false);
  });

  it("flattens a nested tree without looping", () => {
    const all = flattenExpr(parseExpr("$.a.map(x => ({ v: [x, $.b] }))"));
    expect(all.length).toBeGreaterThan(5);
    expect(all.filter((e) => e.type === "FieldRef").length).toBeGreaterThanOrEqual(2);
  });

  it("reaches a deeply buried marker", () => {
    // Six levels down, through a lambda block, an object, and an array.
    const src = `$.a.map(x => { const q = [{ v: $.b.filter(y => y.z === $.${MARK}) }]; return q; })`;
    expect(someExpr(parseExpr(src), hasMarker)).toBe(true);
  });
});
