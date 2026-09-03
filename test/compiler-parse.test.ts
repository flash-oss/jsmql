// Phase 2 of src/compiler/ — the Pratt parser driven by productions.ts.
//
// Two properties matter. It must parse everything the old compiler accepts, and
// it must REFUSE the JavaScript-syntax forms the old parser wrongly allowed. The
// old MQL is guidance, not a target; the old parser's ACCEPTANCE is the floor.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";
import { parse, parseEntry, parseExpression } from "../src/compiler/parse/parser.ts";
import { INFIX, PREFIX } from "../src/compiler/parse/tables.ts";
import { PRODUCTIONS } from "../src/registry/productions.ts";
import { TOKENS } from "../src/registry/tokens.ts";
import { KEYWORDS } from "../src/registry/keywords.ts";
import { ASSIGN_OPS, BINARY_OPS, UNARY_OPS, type Program } from "../src/registry/ast.ts";

function harvestInputs(): string[] {
  const found = new Set<string>();
  const dir = new URL(".", import.meta.url).pathname;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.ts"))) {
    const src = readFileSync(dir + file, "utf8");
    for (const m of src.matchAll(/jsmql(?:\.\w+)?\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const s = m[2].replace(/\\(['"\\])/g, "$1").replace(/\\n/g, "\n");
      if (s.length > 0 && s.length < 400) found.add(s);
    }
  }
  return [...found];
}

/**
 * The one statement of a program. A trailing `;` keeps the `Pipeline` wrapper —
 * that `;` is the token that says pipeline — so a test about the statement
 * itself unwraps it first.
 */
const only = (src: string): { type: string } & Record<string, unknown> => {
  const n = parse(src) as { type: string; stmts?: unknown[] } & Record<string, unknown>;
  return n.type === "Pipeline" && n.stmts?.length === 1 ? (n.stmts[0] as typeof n) : n;
};

describe("compiler/parse — parses everything the old compiler accepts", () => {
  it("has no input the old compiler compiles and the new parser cannot read", () => {
    const failures: string[] = [];
    for (const src of harvestInputs()) {
      let oldOk = true;
      try {
        jsmql(src);
      } catch {
        oldOk = false;
      }
      if (!oldOk) continue;
      try {
        parse(src);
      } catch (e) {
        failures.push(`${JSON.stringify(src)} — ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("compiler/parse — the JavaScript forms the old parser wrongly accepted", () => {
  // Each of these is a SyntaxError under `node --check`, and each compiled before.
  const refused: [string, RegExp][] = [
    ["$.a ?? $.b || $.c", /without parentheses/],
    ["$.a || $.b ?? $.c", /without parentheses/],
    ["$.a ?? $.b && $.c", /without parentheses/],
    ["typeof $.a ** $.b", /without parentheses/],
    ["!$.a ** $.b", /without parentheses/],
    ["~$.a ** $.b", /without parentheses/],
    ["$.a?.b = 1", /cannot be assigned to.*Drop the '\?\.'/],
    ["$.a?.b += 1", /cannot be assigned to.*Drop the '\?\.'/],
  ];
  for (const [src, message] of refused) {
    it(`refuses ${src}`, () => {
      expect(() => parse(src)).toThrow(message);
    });
  }

  it("still accepts each of them when parenthesised", () => {
    expect(() => parseExpression("($.a ?? $.b) || $.c")).not.toThrow();
    expect(() => parseExpression("(typeof $.a) ** $.b")).not.toThrow();
    expect(() => parse("$.a.b = 1")).not.toThrow();
  });
});

describe("compiler/parse — precedence and associativity come from the rows", () => {
  it("refuses a chain where the row says associativity none", () => {
    for (const src of ["$.a < $.b < $.c", "$.a === $.b === $.c", "$.a > $.b >= $.c"]) {
      expect(() => parseExpression(src), src).toThrow(/does not chain/);
    }
  });

  it("binds tighter levels first", () => {
    const t = parseExpression("$.a + $.b * $.c");
    // + is looser, so it is the root and * is its right operand.
    expect(t.type).toBe("BinaryExpr");
    expect((t as { op: string }).op).toBe("+");
    expect((t as { right: { op: string } }).right.op).toBe("*");
  });

  it("folds left for a left-associative level and right for a right one", () => {
    const left = parseExpression("$.a - $.b - $.c") as { left: { op?: string } };
    expect(left.left.op).toBe("-");
    const right = parseExpression("$.a ** $.b ** $.c") as { right: { op?: string } };
    expect(right.right.op).toBe("**");
  });

  it("covers every operator row in the derived tables", () => {
    const withFixity = Object.entries(PRODUCTIONS).filter(([, r]) => (r as { fixity?: string }).fixity !== undefined);
    const covered = new Set<string>();
    for (const r of [...PREFIX.values(), ...INFIX.values()]) for (const n of r.rules) covered.add(n);
    const missing = withFixity.map(([n]) => n).filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
  });
});

describe("compiler/parse — name-blind", () => {
  it("reads a namespace call as a method call on a plain name", () => {
    expect(parseExpression("Math.max($.a, $.b)")).toMatchObject({
      type: "MethodCall",
      name: "max",
      object: { type: "Ident", name: "Math" },
    });
  });

  it("reads a value-receiver call of the SAME name identically", () => {
    expect(parseExpression("$.rows.max()")).toMatchObject({
      type: "MethodCall",
      name: "max",
      object: { type: "FieldRef", path: "rows" },
    });
  });

  it("reads a conversion call as a plain call", () => {
    expect(parseExpression("Number($.s)")).toMatchObject({
      type: "CallExpression",
      callee: { type: "Ident", name: "Number" },
    });
  });

  it("gives the three context references three node types", () => {
    expect(parseExpression("$$").type).toBe("CollectionRef");
    expect(parseExpression("$$$.orders").type).toBe("MemberAccess");
    expect((parseExpression("$$$.orders") as { object: { type: string } }).object.type).toBe("DatabaseRef");
    expect((parseExpression("$$$$.db.c") as { object: { object: { type: string } } }).object.object.type).toBe(
      "ClusterRef",
    );
  });

  it("re-reads 0x with exactly 24 hex digits as an ObjectId", () => {
    expect(parseExpression("0x507f1f77bcf86cd799439011")).toMatchObject({
      type: "ObjectIdLiteral",
      hex: "507f1f77bcf86cd799439011",
    });
    expect(parseExpression("0xff")).toMatchObject({ type: "NumberLiteral", value: 255 });
  });
});

describe("compiler/parse — the parser decides nothing about meaning", () => {
  it("keeps a compound write as written, for desugar to reduce", () => {
    expect(only("$.views += 2;")).toMatchObject({ type: "UpdateFilter", ops: [{ type: "AssignExpr", op: "+=" }] });
    expect(only("$.views++;")).toMatchObject({ ops: [{ op: "++" }] });
  });

  it("records a stage-shaped callback block without judging it", () => {
    const t = only("$$ = $$.aggregate(o => { $sort({ a: 1 }); });") as unknown as {
      ops: [{ value: { args: [{ stages?: unknown; body?: unknown }] } }];
    };
    const lambda = t.ops[0].value.args[0];
    expect(lambda.stages).toBeDefined();
    expect(lambda.body).toBeUndefined();
  });

  it("reads a JavaScript callback block as declarations and a result", () => {
    const t = parseExpression("$.items.map(x => { const y = x * 2; return y })") as {
      args: [{ body: { type: string; decls: unknown[] } }];
    };
    expect(t.args[0].body.type).toBe("ExprBlock");
    expect(t.args[0].body.decls).toHaveLength(1);
  });

  it("accepts both spellings of a declared function", () => {
    expect(parse("const f = (x) => x + 1; $.y = f(2);")).toMatchObject({ type: "Pipeline" });
    expect(parse("function f(x) { return x + 1 } $.y = f(2);")).toMatchObject({ type: "Pipeline" });
  });
});

describe("compiler/parse — the entry form", () => {
  it("separates the params destructure from the toolbox by its KEYS, not its position", () => {
    const r = parseEntry("({ minAge }, { $ }) => $.age >= minAge");
    expect(r.params.map((p) => p.key)).toEqual(["minAge"]);
    expect(r.toolbox.map((p) => p.key)).toEqual(["$"]);
    expect(r.program.type).toBe("BinaryExpr");
  });

  it("binds every toolbox spelling", () => {
    expect(parseEntry("({ $, $$, $$$, $$$$ }) => $.a > 1").toolbox.map((p) => p.key)).toEqual([
      "$",
      "$$",
      "$$$",
      "$$$$",
    ]);
    expect(parseEntry("({ $, $match }) => $.a > 1").toolbox.map((p) => p.key)).toEqual(["$", "$match"]);
  });

  it("records a `key: alias` rename on both halves", () => {
    const r = parseEntry("({ minAge: lo }, { $ }) => $.age >= lo");
    expect(r.params[0]).toMatchObject({ key: "minAge", name: "lo" });
  });

  it("takes an expression body, a `return` body, or a statement body", () => {
    expect(parseEntry("({ $ }) => $.age > 18").program.type).toBe("BinaryExpr");
    expect(parseEntry("({ $ }) => { return $.age > 18 }").program.type).toBe("BinaryExpr");
    expect(parseEntry("({ $ }) => { $.a = 1; $sort({ b: 1 }); }").program.type).toBe("Pipeline");
  });

  it("accepts no parameters at all", () => {
    expect(parseEntry("() => $.age > 18").program.type).toBe("BinaryExpr");
  });

  const refused: [string, RegExp][] = [
    ["({ $ }, { minAge }) => $.a > 1", /toolbox is the SECOND slot/],
    ["({ $, minAge }) => $.a > 1", /either query parameters or the '\$'-prefixed toolbox/],
    ["(o) => o.age > 18", /object destructure pattern/],
    ["({ $ }, { a }, { b }) => $.a > 1", /at most two parameters/],
    ["({}) => $.a > 1", /binds nothing/],
  ];
  for (const [src, message] of refused) {
    it(`refuses ${src}`, () => {
      expect(() => parseEntry(src)).toThrow(message);
    });
  }
});

describe("compiler/parse — a run of writes is ONE element, and keeps every op", () => {
  /** The elements of a bracketed pipeline, each written as what it holds. */
  const elements = (src: string): string[] => {
    const t = parse(src) as { elements: { type: string; ops?: { target?: { path?: string } }[] }[] };
    return t.elements.map((e) =>
      e.type === "UpdateFilter" ? `write(${e.ops?.map((o) => o.target?.path ?? "?").join(",")})` : e.type,
    );
  };

  it("joins consecutive writes into a single update element", () => {
    expect(elements("[$.b = 1, $.c = 2]")).toEqual(["write(b,c)"]);
    expect(elements("[++$.a, ++$.b]")).toEqual(["write(a,b)"]);
    expect(elements("[delete $.a, delete $.b]")).toEqual(["write(a,b)"]);
    expect(elements("[$.b = 1, ++$.c]")).toEqual(["write(b,c)"]);
  });

  it("ends the run at the first element that is not a write", () => {
    expect(elements("[$.b = 1, $match($.x > 1)]")).toEqual(["write(b)", "OperatorCall"]);
    expect(elements("[$match($.x > 1), ++$.a, ++$.b]")).toEqual(["OperatorCall", "write(a,b)"]);
  });

  it("keeps every op of a run a formatter wrapped in parentheses", () => {
    expect(elements("[($.b = 1, $.c = 2)]")).toEqual(["write(b,c)"]);
    expect(elements("[(delete $.a, delete $.b)]")).toEqual(["write(a,b)"]);
  });

  it("leaves an array of values an array of values", () => {
    expect(elements("[1, 2, 3]")).toEqual(["NumberLiteral", "NumberLiteral", "NumberLiteral"]);
    expect(elements("[...$.a, ...$.b]")).toEqual(["SpreadElement", "SpreadElement"]);
  });

  it("accepts the trailing comma a formatter leaves before a closing brace", () => {
    const block = parseEntry("({ $ }) => { $.a = 1, $.b = 2, }").program as { ops: unknown[] };
    expect(block.ops).toHaveLength(2);
    expect((parse("[$.a = 1, $.b = 2,]") as { elements: { ops: unknown[] }[] }).elements[0].ops).toHaveLength(2);
  });

  it("gives every target of a chained assignment the same value", () => {
    const t = only("$.a = $.b = 1;") as unknown as { ops: { target: { path: string }; value: { value: number } }[] };
    expect(t.ops.map((o) => o.target.path)).toEqual(["a", "b"]);
    expect(t.ops.map((o) => o.value.value)).toEqual([1, 1]);
  });
});

describe("compiler/parse — a top-level `;` is kept, because it says PIPELINE", () => {
  it("wraps a lone statement the source ended with `;`", () => {
    // `Object.assign($.a, $.b)` merges two objects and
    // `Object.assign($.a, $.b);` writes the document. Collapsing the single
    // statement threw that `;` away and the two parsed to the same tree.
    expect(parse("Object.assign($.a, $.b)").type).toBe("MethodCall");
    expect(parse("Object.assign($.a, $.b);").type).toBe("Pipeline");
  });

  it("leaves a statement with no `;` standing on its own", () => {
    expect(parse("$.a > 1").type).toBe("BinaryExpr");
    expect(parse("$.a = 1").type).toBe("UpdateFilter");
    expect(parse("$.items.sort()").type).toBe("MethodCall");
  });

  it("reads a `function` declaration inside a bracketed pipeline as a declaration", () => {
    // As a function VALUE it made the literal look like an array of values.
    const t = parse("[function double(x) { return x * 2 }, $set({ a: double($.price) })]") as {
      elements: { type: string }[];
    };
    expect(t.elements[0].type).toBe("FuncDecl");
  });
});

describe("compiler/parse — the operators a row consumes are the operators the AST holds", () => {
  /**
   * The parser builds a BinaryExpr / UnaryExpr / AssignExpr from the token's own
   * TEXT — no table maps a token type back to a spelling. So the one thing that
   * must hold is that every operator lexeme such a row consumes is a member of
   * the AST's operator set. A type-level version of this check was vacuous:
   * `becomes` is not threaded through a const generic, so a conditional on it
   * sees `NodeName` and matches nothing. Runtime data cannot collapse that way.
   */
  // An operator-role token anywhere in the row, or a keyword only as the row's
  // TRIGGER (`in`, `typeof`): `foreignJoin` also consumes `const` and `let` on
  // the way to its `=`, and neither is the operator it builds.
  const operatorRole = (lexeme: string): boolean =>
    (TOKENS as Record<string, { role?: string } | undefined>)[lexeme]?.role === "operator";
  const consumedBy = (node: string): string[] =>
    Object.values(PRODUCTIONS)
      .filter((r) => r.becomes === node)
      .flatMap((r) => {
        const tokens = r.tokens as readonly string[];
        return tokens.filter((t, i) => operatorRole(t) || (i === 0 && t in KEYWORDS));
      });

  it("holds every binary, unary and assignment operator", () => {
    expect(consumedBy("BinaryExpr").filter((op) => !(BINARY_OPS as readonly string[]).includes(op))).toEqual([]);
    expect(consumedBy("UnaryExpr").filter((op) => !(UNARY_OPS as readonly string[]).includes(op))).toEqual([]);
    expect(consumedBy("AssignExpr").filter((op) => !(ASSIGN_OPS as readonly string[]).includes(op))).toEqual([]);
  });

  it("names no operator the rows never consume", () => {
    // The other direction: a spelling in the AST with no row is unreachable.
    const rows = new Set([...consumedBy("BinaryExpr"), ...consumedBy("UnaryExpr"), ...consumedBy("AssignExpr")]);
    for (const op of [...BINARY_OPS, ...UNARY_OPS, ...ASSIGN_OPS]) expect(rows.has(op), op).toBe(true);
  });
});

describe("compiler/parse — a reserved word is a legal name", () => {
  it("accepts every keyword as an object key and after `$.`, driven off keywords.ts", () => {
    // ECMAScript allows any IdentifierName after `.` and before `:`; a MongoDB
    // field may be named anything. A new keyword is covered the day its row lands.
    for (const word of Object.keys(KEYWORDS)) {
      const entry = (parseExpression(`({ ${word}: 1 })`) as { entries: { key: { name?: string } }[] }).entries[0];
      expect(entry.key.name, word).toBe(word);
      expect((parseExpression(`$.${word}`) as { path: string }).path, word).toBe(word);
    }
    // The raw `$let` document, which the shipped compiler could not parse at all.
    expect(() => parseExpression('{ $let: { vars: { x: 1 }, in: "$$x" } }')).not.toThrow();
    expect(() => parseExpression('$let({ vars: { x: 1 }, in: "$$x" })')).not.toThrow();
  });

  it("refuses a keyword as a SHORTHAND property, which JavaScript refuses too", () => {
    // `({ in })` is a SyntaxError (node --check); only `undefined` is an
    // identifier reference and so a legal shorthand.
    for (const word of Object.keys(KEYWORDS)) {
      if (word === "undefined") continue;
      expect(() => parseExpression(`({ ${word} })`), word).toThrow(/cannot be a shorthand property/);
    }
    expect(() => parseExpression("({ undefined })")).not.toThrow();
  });

  it("divides a field named after a keyword instead of reading a regex", () => {
    const e = parseExpression("$.typeof / 2") as { type: string; op?: string };
    expect(e.type).toBe("BinaryExpr");
    expect(e.op).toBe("/");
  });
});

describe("compiler/parse — the `**` restriction is one-sided, as JavaScript states it", () => {
  it("refuses a unary on the LEFT and accepts one on the RIGHT", () => {
    // node --check: `-2 ** 2` and `typeof a ** 2` are SyntaxErrors; `2 ** -1`
    // and `2 ** typeof a` parse. A symmetric rule refused the valid half.
    expect(() => parseExpression("-2 ** 2")).toThrow(/without parentheses/);
    expect(() => parseExpression("typeof $.a ** 2")).toThrow(/without parentheses/);
    expect(() => parseExpression("2 ** -1")).not.toThrow();
    expect(() => parseExpression("2 ** typeof $.a")).not.toThrow();
    expect(() => parseExpression("(-2) ** 2")).not.toThrow();
  });

  it("keeps `??` symmetric", () => {
    expect(() => parseExpression("$.a ?? $.b || $.c")).toThrow(/without parentheses/);
    expect(() => parseExpression("$.a || $.b ?? $.c")).toThrow(/without parentheses/);
  });
});

describe("compiler/parse — a `{ … }` callback body is stages only where its row says so", () => {
  it("accepts a stages block under the one name whose row says blockBody: 'stages'", () => {
    expect(() => parse("$$.aggregate(o => { $match(o.a > 1) });")).not.toThrow();
  });

  it("refuses a block with no `return` under every other callee, with the rewrite hint", () => {
    expect(() => parse("$.items.map(x => { $.a = 1 })")).toThrow(/must end with a `return <expr>`/);
    expect(() => parse("$.v = $.items.filter(x => { x.a; });")).toThrow(/must end with a `return <expr>`/);
    // A declared function is not a stages callee either.
    expect(() => parse("const f = x => { $.a = 1 }; $.b = 1;")).toThrow(/must end with a `return <expr>`/);
    expect(() => parse("f(x => { $.a = 1 })")).toThrow(/must end with a `return <expr>`/);
  });

  it("still takes a block WITH a return anywhere", () => {
    expect(() => parse("$.items.map(x => { const y = x * 2; return y })")).not.toThrow();
  });
});

describe("compiler/parse — one statement loop", () => {
  /** The tree with positions erased, so two spellings at different columns compare equal. */
  const shape = (p: Program): string => JSON.stringify(p, (k, v) => (k === "pos" ? 0 : v));

  it("gives an entry block exactly the meaning of the same text at the top level", () => {
    // The entry block and the top level used to have separate loops, and only
    // the top-level one read a trailing `;` as "this is a pipeline".
    for (const src of [
      "$.a > 1",
      "$.a > 1;",
      "$.a = 1",
      "$.a = 1;",
      "let x = 1; $.a === x",
      "$match($.a > 1); $.b = 2;",
    ]) {
      expect(shape(parseEntry(`({ $ }) => { ${src} }`).program), src).toBe(shape(parse(src)));
    }
  });

  it("carries a real position on every entry-form refusal", () => {
    const at = (src: string): number => {
      try {
        parseEntry(src);
      } catch (e) {
        return (e as { pos: number }).pos;
      }
      return -1;
    };
    expect(at("({ a }, { $ }, { b }) => 1")).toBe("({ a }, { $ }, ".length + 2);
    expect(at("({ $ }) => { $.a = 1; return $.b }")).toBe("({ $ }) => { $.a = 1; ".length);
  });
});
