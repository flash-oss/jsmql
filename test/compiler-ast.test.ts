// Phase 2 of src/compiler/ — the tree src/compiler/parse/ builds.
//
// The AST lives in the registry and imports nothing, so `NodeName` is DERIVED
// from it. These tests pin its two properties: it is name-blind, and it covers
// exactly what the productions claim to build.

import { describe, expect, it } from "vitest";
import { PRODUCTIONS } from "../src/registry/productions.ts";
import type { NodeName } from "../src/registry/vocabulary.ts";
import type { AssignOp, BinaryOp, Node, UnaryOp } from "../src/registry/ast.ts";

/** Every node name a production says it builds. */
function claimed(): Set<string> {
  const out = new Set<string>();
  for (const row of Object.values(PRODUCTIONS)) {
    const b = row.becomes as unknown;
    if (typeof b === "string") out.add(b);
    else if (Array.isArray(b)) for (const n of b) out.add(n as string);
  }
  return out;
}

// A compile-time list of every member of the union, so the runtime check below
// cannot silently miss one. Adding a node to ast.ts without listing it here is a
// type error.
const EVERY_NODE: Record<Node["type"], true> = {
  NumberLiteral: true,
  BigIntLiteral: true,
  StringLiteral: true,
  BooleanLiteral: true,
  NullLiteral: true,
  UndefinedLiteral: true,
  RegexLiteral: true,
  ObjectIdLiteral: true,
  Injected: true,
  TemplateLiteral: true,
  ArrayLiteral: true,
  ObjectLiteral: true,
  FieldRef: true,
  CollectionRef: true,
  DatabaseRef: true,
  ClusterRef: true,
  Ident: true,
  MemberAccess: true,
  IndexAccess: true,
  MethodCall: true,
  CallExpression: true,
  NewExpression: true,
  OperatorCall: true,
  UnaryExpr: true,
  BinaryExpr: true,
  TernaryExpr: true,
  Lambda: true,
  ExprBlock: true,
  SpreadElement: true,
  KeyValueEntry: true,
  LetDecl: true,
  FuncDecl: true,
  AssignExpr: true,
  DeleteStmt: true,
  UpdateFilter: true,
  Pipeline: true,
};

describe("registry/ast — the tree and the rules agree", () => {
  it("has one node type per shape and no more", () => {
    expect(Object.keys(EVERY_NODE)).toHaveLength(36);
  });

  it("every node a production claims to build exists in the tree", () => {
    const missing = [...claimed()].filter((n) => !(n in EVERY_NODE));
    expect(missing).toEqual([]);
  });

  it("every node in the tree is built by some production", () => {
    const built = claimed();
    // `ObjectIdLiteral` is reached two ways and both are productions; nothing here
    // should be unreachable, or the tree carries a shape no syntax produces.
    const orphans = Object.keys(EVERY_NODE).filter((n) => !built.has(n));
    expect(orphans).toEqual([]);
  });

  it("NodeName is derived, so it cannot drift from the shapes", () => {
    const derived: Record<NodeName, true> = EVERY_NODE;
    expect(Object.keys(derived).length).toBe(Object.keys(EVERY_NODE).length);
  });
});

describe("registry/ast — name-blind", () => {
  it("holds no node type named after a particular JavaScript name", () => {
    const nameAware = Object.keys(EVERY_NODE).filter(
      (n) =>
        /^(Math|Object|Number|Array|Date|Set|TypeCast)/.test(n) &&
        n !== "ObjectLiteral" &&
        n !== "ObjectIdLiteral" &&
        n !== "NumberLiteral" &&
        n !== "ArrayLiteral",
    );
    expect(nameAware).toEqual([]);
  });

  it("spells operators exactly as the source spells them", () => {
    const binary: BinaryOp[] = ["??", "||", "&&", "===", "in", "**", "%"];
    const unary: UnaryOp[] = ["!", "-", "~", "typeof"];
    // The compound and increment forms survive parsing so desugar can reduce them.
    const assign: AssignOp[] = ["=", "+=", "-=", "*=", "/=", "++", "--"];
    expect([binary.length, unary.length, assign.length]).toEqual([7, 4, 7]);
  });
});
