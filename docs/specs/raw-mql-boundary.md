# The raw MQL boundary (HR6)

This spec owns the implementation of HR6: raw MQL can hold JSMQL, and JSMQL
cannot take raw MQL as an operand. It also owns the two readings of a `"$…"`
string: a field path in raw MQL, and text in JSMQL. The rule itself, with its examples, lives in
[docs/LANG_RULES.md](../LANG_RULES.md). The module is
[src/compiler/passes/raw-mql.ts](../../src/compiler/passes/raw-mql.ts).

## When the check runs

The check reads the tree as the parser gives it. Both entries call it once per
program:

- `lowerMode` in [src/index.ts](../../src/index.ts) calls it on the parsed tree,
  after the entry settles the road and before `inject`. This covers the string,
  the arrow and the template tag, every `.compile` builder, the CLI and the
  mongoose plugin.
- Each entry of [src/compiler/index.ts](../../src/compiler/index.ts) calls it
  before `fold`.

Two reasons fix this place:

1. **A passed value is not source.** Before `inject`, a template `${…}` slot or a
   `jsmql.compile` parameter is still a name. A name is JSMQL, so the check never
   sees the value. `` jsmql`${base} && $.qty > 5` `` merges `base` as a query
   document.
2. **A later phase moves nodes.** `fold` inlines a `const` binding, and a desugar
   rule rewrites a method to another spelling. After them, the tree no longer
   shows what the developer wrote.

## The contexts

One walk carries the context of each node:

| Context | Where the node stands |
|---|---|
| `program` | the program root; a statement; a stage of `.aggregate([…])` |
| `raw` | an argument of an `$op(…)` call or of a stage link; a value under a `$` key |
| `jsmql` | the right side of `=`; a `let` or `const` value; a callback body or `return` value; the receiver of a stage link |
| `operand` | a value that a JSMQL construct computes with |

A raw MQL node in the `operand` context is the error. A raw MQL node is an
`OperatorCall`, or an `ObjectLiteral` with a static key that starts with `$`.

An `ObjectLiteral` with no `$` key and an `ArrayLiteral` hold values and compute
nothing, so each entry keeps the context of its literal. So an operand stays an
operand at every depth: `$.items.concat([$abs($.x)])` is an error.

A node that computes gives each child the `operand` context. These are the nodes:

- `BinaryExpr`, `UnaryExpr` and `TernaryExpr`
- `MemberAccess` and `IndexAccess`
- `TemplateLiteral` and `SpreadElement`
- the receiver and the arguments of a `MethodCall`
- the arguments of a `CallExpression` and a `NewExpression`
- the right side of a compound `AssignExpr`

A `Lambda` starts again: its body is `jsmql`, and its stage block is a list of
statements.

## The registry facts the walk reads

The walk names no operator and no method. It reads three row facts through
[src/compiler/rows.ts](../../src/compiler/rows.ts):

- `blockBodyOf(name) === "stages"`: the method takes stages. Each element of its
  array argument is a statement (`.aggregate([{ $match: … }])`).
- `bodySlotAt(name, [])?.at === "filter"`: the whole body of the stage is a
  filter (`$match`). Its argument starts a query spine (see below).
- `isGlobalName(name)`: the receiver is a global, so the message spells a static
  call with its name (`'Date.UTC()'`).

A method whose name starts with `$` is a stage link. Its receiver is the stream,
and its argument is raw MQL. So a JSMQL method can follow a stage link.

## The query spine

On the query road, a plain object in `&&`, `||` or `!` is a query document. The
walk carries a `query` flag. The flag is true at the root of a Filter program and
at the argument of a stage whose whole body is a filter. It stays true through
`&&`, `||` and `!` only. A plain `ObjectLiteral` that is a direct operand of one
of them, while the flag is true, is the error:

```
{ status: "A" } && $.qty > 5        (Filter)
  ✗ '{ status: … }' is a query document (raw MQL), and raw MQL cannot be an operand of '&&'.
$match({ status: "A" } && $.qty > 5);
  ✗ the same message
{ status: "A" } && $.qty > 5        (jsmql.expr)
  → { $let: { vars: { jsmqlV: { status: "A" } }, in: { $gt: ["$qty", 5] } } }   a JavaScript object
```

## The message

One template serves every refusal:

```
'<raw>' is raw MQL, and raw MQL cannot be <role>.
'<raw>' is a query document (raw MQL), and raw MQL cannot be <role>.
```

`<raw>` is `$name(…)` for a call, `{ $key: … }` for a `$`-key object, and
`{ key: … }` for a query document. `<role>` names the nearest JSMQL construct:
`an operand of '&&'`, `the receiver of '.map()'`, `an operand of 'Date.UTC()'`,
`an operand of a template literal`. `.pos` is the position of the raw node. The
message names no other spelling (see the HR6 text).

## The text string

The same walk marks each `StringLiteral` that starts with `$` in the `jsmql` or the
`operand` context: `text: true`. In the `program` and the `raw` contexts the string
stays unmarked, and it is a field path (HR1). The marks go on the parsed tree itself.
A `.compile` builder reuses that tree, and each run gives the same marks. So the
entry calls the pass before `inject`, which copies the tree.

A mark is not a new node, so each compile-time reader keeps `.value`: the fold, the
regex road of `.startsWith()`, a constant length, the string type of `+`. The one
question "is this a field path?" has one answer, `isFieldPathString(node)` in
[src/registry/ast.ts](../../src/registry/ast.ts). Every site that used to test
`value.startsWith("$")` on a source node asks it.

The fold computes only from JSMQL constructs (`EVALUABLE_TYPES` in
[src/compiler/passes/fold.ts](../../src/compiler/passes/fold.ts)), and a `const`
value is a whole value that JSMQL owns. So each string that the fold spells is text:
`asLiteral(value, pos, true)`. So `$project({ x: "$y" + "!" })` gives
`{ $literal: "$y!" }`, and `const s = "$y"; $unwind(s)` is refused, not a path.

The emit phase reads a marked string with the placement of a run-time value
(`injectedPlacement` in [src/compiler/emit/env.ts](../../src/compiler/emit/env.ts)):
`{ $literal: … }` where the server evaluates it, the string as written in a query, an
update document and a developer's own `$literal`, and a refusal where the string
becomes part of the MQL. A lowered `{ $literal: "…" }` is still constant text:
`constantText` in [src/registry/mql.ts](../../src/registry/mql.ts) reads it, so a
length or a one-character pad folds as it does for a plain string.

```
$.file.endsWith("$ext")   → … { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 4] } … { $literal: "$ext" }
$.s.startsWith("$")       → { s: { $regex: /^\$/ } }                     (Filter)
$.a["$y"]                 → { $getField: { field: { $literal: "$y" }, input: { $ifNull: ["$a", {}] } } }
```
