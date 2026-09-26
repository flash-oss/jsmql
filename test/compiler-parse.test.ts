// Phase 2 of src/compiler/ — the Pratt parser driven by productions.ts.
//
// Two properties matter. It must parse every source the test suite compiles, and
// it must REFUSE the forms that are a SyntaxError in JavaScript itself — every
// jsmql program is valid JavaScript syntax.

import { readdirSync, readFileSync } from "node:fs";
import { Script } from "node:vm";
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
 * Extract the one statement of a program. A trailing `;` keeps the `Pipeline` wrapper.
 * That `;` is the token that says "pipeline". A test about the statement itself must
 * unwrap it first.
 */
const only = (src: string): { type: string } & Record<string, unknown> => {
  const n = parse(src) as { type: string; stmts?: unknown[] } & Record<string, unknown>;
  return n.type === "Pipeline" && n.stmts?.length === 1 ? (n.stmts[0] as typeof n) : n;
};

describe("compiler/parse — every source the compiler accepts is JavaScript syntax", () => {
  /** Does JavaScript parse the source, as a script or as one parenthesised expression? */
  const isJs = (src: string): boolean => {
    for (const text of [src, `(${src}\n)`]) {
      try {
        new Script(text);
        return true;
      } catch {
        // try the other reading
      }
    }
    return false;
  };
  const compiles = (src: string): boolean => {
    try {
      jsmql(src);
      return true;
    } catch {
      return false;
    }
  };

  it("parses every string source the suites compile as JavaScript", () => {
    const accepted = harvestInputs().filter(compiles);
    // The harvest reads every suite in test/. A regex that stops matching reads nothing.
    expect(accepted.length).toBeGreaterThan(1000);
    const failures = accepted.filter((src) => !isJs(src));
    expect(failures).toEqual([]);
  });
});

describe("compiler/parse — a program is JavaScript syntax: the refusals, word for word", () => {
  const TRAILING = (pos: number, next: string): string =>
    `A ',' with no write after it, before ${next} at position ${pos}. JavaScript allows a trailing ',' in a list, but not at the end of a statement or of a '( … )' group. Delete the ',' ('$.a = 1;'), or write the next write after it ('$.a = 1, $.b = 2;').`;
  const ELEMENT = (wrote: string, pos: number): string =>
    `\`${wrote}\` is a declaration, and JavaScript refuses a declaration as an array element, at position ${pos}. Write the pipeline as statements, with a ';' after each one: \`${wrote}; $match(…);\`. In a stage's sub-pipeline, write the value inline in the stage that reads it.`;
  const PARAM = (wrote: string, name: string, pos: number): string =>
    `\`${wrote}\` re-declares the parameter \`${name}\` at position ${pos}, which JavaScript refuses. Pick a different name.`;
  const AGAIN = (wrote: string, pos: number): string =>
    `\`${wrote}\` at position ${pos} is already declared earlier in this block, which JavaScript refuses. Pick a different name.`;
  const TWICE = (name: string, pos: number): string =>
    `The parameter name '${name}' appears twice in one parameter list, at position ${pos}. JavaScript refuses a duplicate parameter name here. Give each parameter its own name, for example '(x, i) => …'.`;

  // [source, message, .pos]. JavaScript refuses each source too; the test asks `node:vm` for that answer.
  const refused: [string, string, number][] = [
    ["$.a = 1,", TRAILING(7, "end of input"), 7],
    ["$.lineTotal = $.qty * $.unitPrice, $.invoiceCount += 1, ", TRAILING(54, "end of input"), 54],
    ["$.a = 1, $.b = 2,;", TRAILING(16, "';'"), 16],
    ["({ $ }) => { $.a = 1, $.b = 2, }", TRAILING(29, "'}'"), 29],
    ["($.a = 1, $.b = 2,);", TRAILING(17, "')'"), 17],
    ["[let x = $.a + 1, $match(x > 5)]", ELEMENT("let x = …", 1), 1],
    ["[ const double = (x) => x * 2, $set({ a: double($.price) }) ]", ELEMENT("const double = …", 2), 2],
    ["[$match($.x > 0), let y = $.x * 2, $sort({ y: 1 })]", ELEMENT("let y = …", 18), 18],
    ["$.v = $.items.map(x => { const x = 99; return x });", PARAM("const x", "x", 25), 25],
    ["$.v = $.items.map(([a, b]) => { const a = 1; return a + b });", PARAM("const a", "a", 32), 32],
    ["function g(x) { let x = 1; return x } $.v = g(1);", PARAM("let x", "x", 16), 16],
    ["({ a }, { $ }) => { const a = 1; $.x = a; }", PARAM("const a", "a", 20), 20],
    ["$$.aggregate((o) => { let o = 1; $.y = o; });", PARAM("let o", "o", 22), 22],
    // The fold inlines a constant, so only the parser can see this pair.
    ["$.v = [1, 2].map((x) => { const y = 1; const y = 2; return y });", AGAIN("const y", 39), 39],
    ["let a = 1; let a = 2; $.x = a;", AGAIN("let a", 11), 11],
    ["let x = $.a, x = $.b; $.c = x;", AGAIN("let x", 13), 13],
    ["$.v = $.items.map((x, x) => x);", TWICE("x", 22), 22],
    ["({ a, a }, { $ }) => $.x > a", TWICE("a", 6), 6],
  ];
  const jsRefuses = (src: string): boolean => {
    for (const text of [src, `(${src}\n)`]) {
      try {
        new Script(text);
        return false;
      } catch {
        // try the other reading
      }
    }
    return true;
  };
  for (const [src, message, pos] of refused) {
    it(`refuses ${src}`, () => {
      expect(jsRefuses(src)).toBe(true);
      let thrown: unknown = null;
      try {
        jsmql(src);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(message);
      expect((thrown as { pos: number }).pos).toBe(pos);
    });
  }

  // The legal neighbour of each refusal. JavaScript parses it, and so does jsmql.
  const kept: [string, unknown][] = [
    ["$.a = 1, $.b = 2", [{ $set: { a: 1, b: 2 } }]],
    ["[$.a = 1, $.b = 2,]", [{ $set: { a: 1, b: 2 } }]],
    [
      "let x = $.a + 1; $match(x > 5);",
      [
        { $set: { "__jsmql.var.x": { $add: ["$a", 1] } } },
        { $match: { $expr: { $gt: ["$__jsmql.var.x", 5] } } },
        { $unset: "__jsmql" },
      ],
    ],
    [
      // A nested function opens a scope of its own, so its `const x` shadows the outer parameter.
      "$.v = $.items.map((x) => $.other.map((y) => { const x = 2; return x + y }));",
      [
        {
          $set: {
            v: {
              $map: {
                input: { $ifNull: ["$items", []] },
                as: "x",
                in: {
                  $map: {
                    input: { $ifNull: ["$other", []] },
                    as: "y",
                    in: { $let: { vars: { x: 2 }, in: { $add: ["$$x", "$$y"] } } },
                  },
                },
              },
            },
          },
        },
      ],
    ],
    // A plain `function` list may name a parameter twice; the last one wins, as in JavaScript.
    ["$.v = [5, 6].map(function (x, x) { return x });", [{ $set: { v: [0, 1] } }]],
  ];
  for (const [src, mql] of kept) {
    it(`keeps ${src}`, () => {
      expect(jsRefuses(src)).toBe(false);
      expect(jsmql(src)).toEqual(mql);
    });
  }
});

describe("compiler/parse — the forms JavaScript itself refuses", () => {
  // Each of these is a SyntaxError under `node --check`, so jsmql refuses it too.
  const refused: [string, RegExp][] = [
    ["$.a ?? $.b || $.c", /without parentheses/],
    ["$.a || $.b ?? $.c", /without parentheses/],
    ["$.a ?? $.b && $.c", /without parentheses/],
    ["typeof $.a ** $.b", /without parentheses/],
    ["!$.a ** $.b", /without parentheses/],
    ["~$.a ** $.b", /without parentheses/],
    ["$.a?.b = 1", /cannot assign to.*Drop the '\?\.'/],
    ["$.a?.b += 1", /cannot assign to.*Drop the '\?\.'/],
  ];
  for (const [src, message] of refused) {
    it(`refuses ${src}`, () => {
      expect(() => parse(src)).toThrow(message);
    });
  }

  /** A parse tree as a compact S-expression, so a test states the exact grouping. */
  const sx = (n: unknown): string => {
    const t = n as Record<string, unknown> & { type: string };
    switch (t.type) {
      case "FieldRef":
        return `$.${t.path as string}`;
      case "NumberLiteral":
        return String(t.value);
      case "MemberAccess":
        return `${sx(t.object)}.${t.name as string}`;
      case "UnaryExpr":
        return `(${t.op as string} ${sx(t.argument)})`;
      case "BinaryExpr":
        return `(${t.op as string} ${sx(t.left)} ${sx(t.right)})`;
      case "UpdateFilter":
        return (t.ops as { target: unknown; op: string; value: unknown }[])
          .map((o) => `(${o.op} ${sx(o.target)} ${sx(o.value)})`)
          .join(" ");
      default:
        return t.type;
    }
  };

  it("accepts each of them when parenthesised, grouped as the parentheses say", () => {
    const grouped: [string, string][] = [
      ["($.a ?? $.b) || $.c", "(|| (?? $.a $.b) $.c)"],
      ["($.a || $.b) ?? $.c", "(?? (|| $.a $.b) $.c)"],
      ["($.a ?? $.b) && $.c", "(&& (?? $.a $.b) $.c)"],
      ["(typeof $.a) ** $.b", "(** (typeof $.a) $.b)"],
      ["(!$.a) ** $.b", "(** (! $.a) $.b)"],
      ["(~$.a) ** $.b", "(** (~ $.a) $.b)"],
    ];
    for (const [src, tree] of grouped) expect(sx(parseExpression(src)), src).toBe(tree);
    // the `?.` forms without the `?.` are a write to a path
    expect(sx(parse("$.a.b = 1"))).toBe("(= $.a.b 1)");
    expect(sx(parse("$.a.b += 1"))).toBe("(+= $.a.b 1)");
  });
});

describe("compiler/parse — a write inside a value: JavaScript's grouping, one refusal", () => {
  // JavaScript binds a postfix `++` tighter than every prefix and binary operator,
  // so `1 + $.x++` is `1 + ($.x++)`. Each source is valid JavaScript; the write sits
  // inside a value, and a write stands only as a statement.
  const IN_VALUE = (wrote: string, statement: string, place: string, side: string, pos: number): string =>
    `'${wrote}' is a write inside a value at position ${pos}. A write stands only as a statement. Write '${statement};' as its own statement ${side} the statement that uses the value, and read '${place}' there.`;
  const refused: [string, string, number][] = [
    ["1 + $.x++", IN_VALUE("$.x++", "$.x += 1", "$.x", "after", 7), 7],
    ["$.y = $.x++;", IN_VALUE("$.x++", "$.x += 1", "$.x", "after", 9), 9],
    ["$.y = ($.x++);", IN_VALUE("$.x++", "$.x += 1", "$.x", "after", 10), 10],
    ["$.y = -$.x++;", IN_VALUE("$.x++", "$.x += 1", "$.x", "after", 10), 10],
    ["$.y = $.x-- * 2;", IN_VALUE("$.x--", "$.x -= 1", "$.x", "after", 9), 9],
    ["$match($.n++ > 1);", IN_VALUE("$.n++", "$.n += 1", "$.n", "after", 10), 10],
    ["$.x++ + 1;", IN_VALUE("$.x++", "$.x += 1", "$.x", "after", 3), 3],
    ["let n = 1; $.y = n++;", IN_VALUE("n++", "n += 1", "n", "after", 18), 18],
    ["$.y = ++$.x;", IN_VALUE("++$.x", "$.x += 1", "$.x", "before", 6), 6],
    ["$.y = 1 + --$.a.b;", IN_VALUE("--$.a.b", "$.a.b -= 1", "$.a.b", "before", 10), 10],
    ["++$.x + 1;", IN_VALUE("++$.x", "$.x += 1", "$.x", "before", 0), 0],
    // The assignment operators are the same rule: JavaScript gives the value after the write.
    ["1 + ($.a = 5);", IN_VALUE("$.a = 5", "$.a = 5", "$.a", "before", 9), 9],
    ["$.y = ($.a += 1);", IN_VALUE("$.a += 1", "$.a += 1", "$.a", "before", 11), 11],
    ["$.y = $.a *= 2;", IN_VALUE("$.a *= 2", "$.a *= 2", "$.a", "before", 10), 10],
    ["$.y = f($.a = 5);", IN_VALUE("$.a = 5", "$.a = 5", "$.a", "before", 12), 12],
    ["$.y = { k: $.a = 5 };", IN_VALUE("$.a = 5", "$.a = 5", "$.a", "before", 15), 15],
  ];
  const jsAccepts = (src: string): boolean => {
    try {
      new Script(src);
      return true;
    } catch {
      return false;
    }
  };
  for (const [src, message, pos] of refused) {
    it(`refuses ${src}`, () => {
      expect(jsAccepts(src)).toBe(true);
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toBe(message);
      expect(result.errors[0].pos).toBe(pos);
    });
  }

  // A write in an ARRAY reads as a pipeline element to the parser. The position
  // pass puts the array in a value, and the desugar pass gives the same refusal.
  const DELETE_IN_VALUE = (place: string, pos: number): string =>
    `'delete ${place}' is a write inside a value at position ${pos}. A write stands only as a statement. Write 'delete ${place};' as its own statement before the statement that uses the value.`;
  const inArrays: [string, string, number][] = [
    ["$.y = [$.x++];", IN_VALUE("$.x++", "$.x += 1", "$.x", "after", 10), 10],
    ["$.y = [++$.x];", IN_VALUE("++$.x", "$.x += 1", "$.x", "before", 7), 7],
    ["$.y = [$.a = 1];", IN_VALUE("$.a = …", "$.a = …", "$.a", "before", 11), 11],
    ["$.y = [1, $.a += 2];", IN_VALUE("$.a += …", "$.a += …", "$.a", "before", 14), 14],
    ["$.y = [($.a = 5)];", IN_VALUE("$.a = …", "$.a = …", "$.a", "before", 12), 12],
    ["$.y = { k: [$.a = 1] };", IN_VALUE("$.a = …", "$.a = …", "$.a", "before", 16), 16],
    ["$match([$.a = 1]);", IN_VALUE("$.a = …", "$.a = …", "$.a", "before", 12), 12],
    ["$.y = [1, delete $.a];", DELETE_IN_VALUE("$.a", 10), 10],
    // JavaScript reads `delete` as a value too.
    ["$.y = f(delete $.a);", DELETE_IN_VALUE("$.a", 8), 8],
    ["$.y = 1 + (delete $.a.b);", DELETE_IN_VALUE("$.a.b", 11), 11],
  ];
  for (const [src, message, pos] of inArrays) {
    it(`refuses ${src}`, () => {
      expect(jsAccepts(src)).toBe(true);
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toBe(message);
      expect(result.errors[0].pos).toBe(pos);
    });
  }

  it("refuses a function in a value, which MQL cannot hold", () => {
    expect(() => jsmql("$.y = [function f(x) { return x }];")).toThrow(
      "'function f(…)' is a function inside a value at position 7. MQL has no function values. Write the function as its own statement at the top level of the pipeline, and call 'f(…)' where the value goes.",
    );
  });

  it("keeps a write in a pipeline array and in a sub-pipeline", () => {
    expect(jsmql("[$.a = 1, $sort({ a: 1 })]")).toEqual([{ $set: { a: 1 } }, { $sort: { a: 1 } }]);
    expect(jsmql("$facet({ a: [$.x = 1] });")).toEqual([{ $facet: { a: [{ $set: { x: 1 } }] } }]);
  });

  it("gives the JavaScript answer for the statement the refusal names", () => {
    // `$.y = $.x++` in JavaScript: y gets the old x, then x grows by one.
    const doc = { x: 1, y: 0 };
    doc.y = doc.x++;
    expect(doc).toEqual({ x: 2, y: 1 });
    // The two statements the refusal names emit the same order: read first, then write.
    expect(jsmql("$.y = $.x; $.x += 1;")).toEqual([{ $set: { y: "$x" } }, { $set: { x: { $add: ["$x", 1] } } }]);
  });

  it("keeps each statement form of the write", () => {
    const kept: [string, unknown][] = [
      ["$.x++;", [{ $set: { x: { $add: ["$x", 1] } } }]],
      ["++$.x;", [{ $set: { x: { $add: ["$x", 1] } } }]],
      ["$.x--;", [{ $set: { x: { $subtract: ["$x", 1] } } }]],
      ["$.x ++;", [{ $set: { x: { $add: ["$x", 1] } } }]],
      ["($.a++);", [{ $set: { a: { $add: ["$a", 1] } } }]],
      ["$.a++, --$.b;", [{ $set: { a: { $add: ["$a", 1] }, b: { $subtract: ["$b", 1] } } }]],
      ["[$.a++, $match($.b > 1)]", [{ $set: { a: { $add: ["$a", 1] } } }, { $match: { b: { $gt: 1 } } }]],
      ["$.y = $.a = 5;", [{ $set: { y: 5, a: 5 } }]],
    ];
    for (const [src, mql] of kept) expect(jsmql(src), src).toEqual(mql);
  });

  it("refuses a callback parameter default, which is not a write", () => {
    const src = "$.v = $.a.map((x = 1) => x);";
    expect(jsAccepts(src)).toBe(true);
    const result = jsmql.validate(src);
    expect(result.errors[0].message).toBe(
      "A callback parameter is a plain name, and a default value ('x = …') is not one, at position 15. Name the parameter, and write the default where the body reads it: 'x => x ?? <default>'.",
    );
    expect(result.errors[0].pos).toBe(15);
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
  it("separates params from the toolbox by key names, not by position", () => {
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

  it("accepts the trailing comma a formatter leaves before a closing bracket", () => {
    // `[a, b,]` is a list, so JavaScript allows its trailing comma. A statement is not a list.
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
    // The raw `$let` document, in both the document and the call spelling.
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
});

describe("compiler/parse — a `{ … }` callback body is stages only where its row says so", () => {
  it("accepts a stages block under the one name whose row says blockBody: 'stages'", () => {
    expect(() => parse("$$.aggregate(o => { $match(o.a > 1) });")).not.toThrow();
  });

  it("refuses a block with no `return` under every other callee, with the rewrite hint", () => {
    expect(() => parse("$.items.map(x => { $.a = 1 })")).toThrow(
      /is a pipeline stage, not part of a callback|must end with a `return <expr>`/,
    );
    expect(() => parse("$.v = $.items.filter(x => { x.a; });")).toThrow(
      /is a pipeline stage, not part of a callback|must end with a `return <expr>`/,
    );
    // A declared function is not a stages callee either.
    expect(() => parse("const f = x => { $.a = 1 }; $.b = 1;")).toThrow(
      /is a pipeline stage, not part of a callback|must end with a `return <expr>`/,
    );
    expect(() => parse("f(x => { $.a = 1 })")).toThrow(
      /is a pipeline stage, not part of a callback|must end with a `return <expr>`/,
    );
  });

  it("still takes a block WITH a return anywhere", () => {
    expect(() => parse("$.items.map(x => { const y = x * 2; return y })")).not.toThrow();
  });
});

describe("compiler/parse — one statement loop", () => {
  /** The tree with positions erased, so two spellings at different columns compare equal. `group` is a position too. */
  const shape = (p: Program): string => JSON.stringify(p, (k, v) => (k === "pos" || k === "group" ? 0 : v));

  it("gives an entry block exactly the meaning of the same text at the top level", () => {
    // One statement loop reads both, so a trailing `;` says "this is a pipeline"
    // inside an entry block exactly as it does at the top level.
    for (const src of [
      "$.a > 1",
      "$.a > 1;",
      "$.a = 1",
      "$.a = 1;",
      "let x = 1; $.a === x",
      "let x = 1, y = x + 1; $.a === y",
      "$match($.a > 1); $.b = 2;",
    ]) {
      expect(shape(parseEntry(`({ $ }) => { ${src} }`).program), src).toBe(shape(parse(src)));
    }
  });

  it("reads a declaration list as the declarations it stands for, all marked as ONE declaration", () => {
    // `const a = …, b = …;` is N declarations in JavaScript, and the parser builds
    // the same N nodes it builds for N statements. The ONE thing a list adds is
    // `group` — the keyword's offset, shared by every declarator of that
    // declaration, which the emit phase reads to give them one stage. Erase it
    // and the trees are equal.
    for (const [list, separate] of [
      ["let x = 1, y = 2; $.a = x + y;", "let x = 1; let y = 2; $.a = x + y;"],
      ["const a = $.p, b = a + 1, c = b * 2; $.d = c;", "const a = $.p; const b = a + 1; const c = b * 2; $.d = c;"],
      ["const f = (v) => v * 2, y = f($.a); $.c = y;", "const f = (v) => v * 2; const y = f($.a); $.c = y;"],
    ]) {
      expect(shape(parse(list)), list).toBe(shape(parse(separate)));
    }
    // One declaration, one group; a `;` starts a new one.
    const groups = (src: string): number[] =>
      (parse(src) as { stmts: { group?: number }[] }).stmts.filter((st) => "group" in st).map((st) => st.group!);
    const oneList = groups("let x = 1, y = 2, z = 3; $.a = x;");
    expect(new Set(oneList).size, "three declarators of one declaration share a group").toBe(1);
    expect(oneList).toHaveLength(3);
    expect(new Set(groups("let x = 1; let y = 2; $.a = x;")).size, "a `;` starts a new declaration").toBe(2);
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

describe("compiler/parse — a destructured parameter is one parameter, its names the parts of it", () => {
  /** The tree without its positions: a substituted part sits where its NAME was written, the spelled-out form where it is read. */
  const noPos = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(noPos);
    if (n === null || typeof n !== "object") return n;
    return Object.fromEntries(
      Object.entries(n as Record<string, unknown>)
        .filter(([k]) => k !== "pos")
        .map(([k, v]) => [k, noPos(v)]),
    );
  };
  const body = (src: string): unknown => {
    const e = parseExpression(src) as { type: string; args?: readonly unknown[] };
    return noPos((e.args as readonly { params: readonly string[]; body?: unknown }[])[0]);
  };

  it("an array pattern reads each name as an index of one fresh parameter", () => {
    expect(body("a.sortBy(([id, count]) => -count)")).toEqual(body("a.sortBy(x => -x[1])"));
    expect(body("a.map(([, second]) => second)")).toEqual(body("a.map(x => x[1])"));
  });

  it("an object pattern reads each name as a field, `key: alias` under the alias", () => {
    expect(body("a.map(({ sku, qty: n }) => sku + n)")).toEqual(body("a.map(x => x.sku + x.qty)"));
  });

  it("the fresh parameter steps aside from every name the body mentions", () => {
    expect(body("a.map(([x]) => x + y)")).toEqual(body("a.map(x2 => x2[0] + y)"));
    expect(body("a.map(([p], x) => p + x)")).toEqual(body("a.map((x2, x) => x2[0] + x)"));
  });

  it("a parameter of an inner arrow shadows a destructured name, as in JavaScript", () => {
    expect(body("a.map(([n]) => b.map(n => n * 2).concat([n]))")).toEqual(
      body("a.map(x => b.map(n => n * 2).concat([x[0]]))"),
    );
  });

  it("the `function` form takes the same patterns, and the block body keeps its `return`", () => {
    expect(jsmql.expr("$.arr.map(function ([a, b]) { return a + b; })")).toEqual(
      jsmql.expr("$.arr.map(function (x) { return x[0] + x[1]; })"),
    );
    expect(jsmql("function f([a, b]) { return a + b; } $.r = f([1, 2]);")).toEqual([{ $set: { r: 3 } }]);
  });

  it("the substitution keeps the body's shape: a sort key still sees its minus", () => {
    expect(jsmql.expr("$.tally.entries().sortBy(([id, count]) => -count)")).toEqual(
      jsmql.expr("$.tally.entries().sortBy(x => -x[1])"),
    );
    expect(jsmql("$$.filter(({ status, qty }) => status === 'paid' && qty > 1);")).toEqual([
      { $match: { status: "paid", qty: { $gt: 1 } } },
    ]);
  });

  it("only plain names: a default, a rest element, a nested pattern or a computed key is refused with the spelling to write", () => {
    const message =
      "A destructured parameter lists plain names only — '([id, count]) => …', '({ sku, qty: n }) => …'. A default value, a rest element, a nested pattern or a computed key";
    expect(() => parseExpression("a.map(([a = 1]) => a)")).toThrow(message);
    expect(() => parseExpression("a.map(([a, ...rest]) => a)")).toThrow(message);
    expect(() => parseExpression("a.map(([[a]]) => a)")).toThrow(message);
    expect(() => parseExpression("a.map(({ a: { b } }) => b)")).toThrow(message);
    expect(() => parseExpression("a.map(({ [k]: v }) => v)")).toThrow(message);
    expect(() => parseExpression("a.map(({ a = 1 }) => a)")).toThrow(message);
    expect(() => parseExpression("a.map(([1, a]) => a)")).toThrow(message);
    // the refusal names what it saw, and points at it
    expect(() => parseExpression("a.map(([a, ...rest]) => a)")).toThrow("('...') is not one of them, at position 11");
  });

  it("a parenthesised list or object that is not followed by an arrow is the expression it looks like", () => {
    expect(jsmql.expr("([1, 2])")).toEqual([1, 2]);
    expect(jsmql.expr("([...$.a, 1])")).toEqual({ $concatArrays: [{ $ifNull: ["$a", []] }, [1]] });
    expect(jsmql.expr("({ a: 1 })")).toEqual({ a: 1 });
  });
});

describe("compiler/parse — a write target is a place, and an optional chain is one expression", () => {
  it("refuses an optional chain anywhere in the target, not only at its end", () => {
    // `a?.b.c = 1` is as much a SyntaxError as `a?.b = 1` (node --check); the
    // rule that built the chain must stay with it through every later link.
    for (const src of ["$.a?.b.c = 1;", "$.a?.b[0] = 1;", "$.a?.b.c++;", "$.a?.b.c += 1;", "$.a = $.b?.c.d = 1;"]) {
      expect(() => parse(src), src).toThrow(/cannot assign to/);
    }
  });

  it("lets `delete` reach through an optional chain, which JavaScript allows", () => {
    expect(() => parse("delete $.a?.b;")).not.toThrow();
  });

  it("refuses a target that is not a place", () => {
    for (const src of ["$.a + 1 = 2;", "1 = 2;", '"x" = 1;', "$.a = 1 = 2;", "++(1 + $.a);", "f() = 1;", "f()++;"]) {
      expect(() => parse(src), src).toThrow(/Cannot apply|cannot be assigned/);
    }
  });

  it("quotes the target as the source spells it", () => {
    const NOT_A_PLACE = (op: string, target: string, pos: number): string =>
      `Cannot apply '${op}' to '${target}' at position ${pos}. You can write only to a field, a binding, '$', '$$' or a collection.`;
    expect(() => parse("1++;")).toThrow(NOT_A_PLACE("++", "1", 1));
    expect(() => parse("delete 1;")).toThrow(NOT_A_PLACE("delete", "1", 0));
    expect(() => parse("$.a + 1 = 2;")).toThrow(NOT_A_PLACE("=", "$.a + 1", 8));
    expect(() => parse("$.a = 1 = 2;")).toThrow(NOT_A_PLACE("=", "1", 8));
  });

  it("refuses an arithmetic write on '$' or '$$', which is not a field", () => {
    // Without this refusal, `$ += 1` would become the valid-looking `$ = $ + 1`.
    const WHOLE = (op: string, target: string, what: string, field: string, pos: number): string =>
      `Cannot use '${op}' on '${target}' at position ${pos}. ${what}, not a field. Write to a field: '${field}'.`;
    const DOC = "'$' is the whole document";
    const STREAM = "'$$' is the stream of documents";
    const refused: [string, string][] = [
      ["$ += 1;", WHOLE("+=", "$", DOC, "$.<field> += …", 2)],
      ["$ -= 1;", WHOLE("-=", "$", DOC, "$.<field> -= …", 2)],
      ["$++;", WHOLE("++", "$", DOC, "$.<field>++", 1)],
      ["++$;", WHOLE("++", "$", DOC, "$.<field>++", 0)],
      ["$$ += 1;", WHOLE("+=", "$$", STREAM, "$.<field> += …", 3)],
      ["$$++;", WHOLE("++", "$$", STREAM, "$.<field>++", 2)],
      // The value form gets the same answer, not a statement that the parser refuses too.
      ["$.y = $$++;", WHOLE("++", "$$", STREAM, "$.<field>++", 8)],
    ];
    for (const [src, message] of refused) expect(() => parse(src), src).toThrow(message);
    // `=` replaces the document or the stream, and a collection takes `+=` as a `$merge`.
    expect(jsmql("$ = { a: 1 };")).toEqual([{ $replaceWith: { a: 1 } }]);
    expect(jsmql("$$$.archive += $$;")).toEqual([{ $merge: "archive" }]);
    expect(jsmql("$.n += 1;")).toEqual([{ $set: { n: { $add: ["$n", 1] } } }]);
  });

  it("accepts a parenthesised target", () => {
    expect(() => parse("($.a) = 1;")).not.toThrow();
  });

  it("refuses a space between `$` and its name", () => {
    // `$ abs(1)` is two identifiers to JavaScript.
    expect(() => parseExpression("$ abs(1)")).toThrow(/directly after '\$'/);
    expect(() => parse("$$.$ group({_id: null});")).toThrow(/directly after '\$'/);
  });

  it("counts a leading `;` as the pipeline token", () => {
    expect(parse("; $.a > 1").type).toBe("Pipeline");
  });

  it("names an operator by its spelling in a mixing refusal, never by its key", () => {
    // The negation row's spelling is `-x`; its key, `negation`, must never reach the user.
    expect(() => parseExpression("-2 ** 2")).toThrow(/'-x'/);
    expect(() => parseExpression("-2 ** 2")).not.toThrow(/negation/);
    expect(() => parseExpression("$.a ?? $.b || $.c")).toThrow(/'\|\|'/);
  });
});

describe("compiler/parse — `$.name(…)` is a method on the document", () => {
  it("reads the parentheses as a call on the bare `$`, and their absence as a field", () => {
    const call = only('$.pick(["a"])') as { object: { type: string; path: string }; name: string; pos: number };
    expect(call.type).toBe("MethodCall");
    expect(call.name).toBe("pick");
    expect(call.object).toEqual({ type: "FieldRef", path: "", pos: 0 });
    // the method's own `.` — where every other method call points
    expect(call.pos).toBe(1);
    expect(only("$.pick")).toEqual({ type: "FieldRef", path: "pick", pos: 0 });
    const chained = only("$.pick.x") as { object: unknown };
    expect(chained.object).toEqual({ type: "FieldRef", path: "pick", pos: 0 });
  });
});
