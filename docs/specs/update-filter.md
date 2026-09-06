# Update filters

How `=`, `+=`, `-=`, `*=`, `/=`, and `delete` lower from JavaScript syntax to MongoDB pipeline `$set` / `$unset` stages.

User-facing reference is `docs/LANGUAGE.md` § Update filters.

## AST

Three node types in `src/registry/ast.ts`:

```ts
type AssignExpr      = { type: "AssignExpr"; target: Expr; value: Expr };
type DeleteStmt      = { type: "DeleteStmt"; target: Expr };
type UpdateOp        = AssignExpr | DeleteStmt;
type UpdateFilter = { type: "UpdateFilter"; update ops: Update op[] };
```

`AssignExpr` does not carry an `op` field. The parser desugars compound operators (`+=`, `-=`, `*=`, `/=`) at construction time: `$.a += rhs` becomes `AssignExpr { target: $.a, value: BinaryExpr("+", $.a, rhs) }`. Codegen therefore only sees plain `=` assignments.

`UpdateFilter` is its own type, not part of the `Expr` union. `Parser.parse()` returns `Program = Expr | UpdateFilter | Pipeline`; `compile()` in `src/index.ts` dispatches on the discriminant. `Pipeline` (from `aggregation-stages.md`) wraps a sequence of `;`-separated top-level statements where each statement is itself an `Expr` or a `UpdateFilter`.

`ArrayElement` is widened to `Expr | SpreadElement | AssignExpr | DeleteStmt` so update ops can sit inside pipeline-array literals. Non-pipeline `ArrayLiteral` codegen rejects update op elements with a clear error.

## Lexer

Six new tokens (`src/compiler/lex/lexer.ts`):

| Token       | Source | Notes |
|-------------|--------|-------|
| `Eq`        | `=`    | Distinct from `EqEq` / `EqEqEq` / `Arrow` (longer-token-first ordering preserved) |
| `PlusEq`    | `+=`   | Two-char lookahead before single-char `Plus` |
| `MinusEq`   | `-=`   | Same as above for `Minus` |
| `StarEq`    | `*=`   | Checked after `**` (StarStar) and before `*` (Star) |
| `SlashEq`   | `/=`   | Only emitted in division-context (`lastTokenType` is value-ending). In regex-context, the `=` after `/` is part of a regex literal. |
| `Semi`      | `;`    | Top-level pipeline-stage separator (see `aggregation-stages.md` § Implicit `;`-separated form). Not consumed by `parseUpdateFilterRest`. |

One new keyword: `Delete` (added to `keywordToken()` switch alongside `typeof`/`new`/`in`).

## Parser

Top-level dispatch (`Parser.parse()`) is a `;`-separated statement loop, not a single dispatch:

1. Collect the first statement via `collectStatement()`. Inside that helper:
   1. If the first token is `Delete`, `++`, or `--` → `parseUpdateFilter()` directly.
   2. Otherwise speculatively `parseExpression()`. If an assignment operator follows, the expression is the first update op target; flow merges into `parseUpdateFilterFrom(target)`. If a postfix `++`/`--` follows, route through `parseUpdateFilterFromPostfix(target)`.
   3. Otherwise return the expression unchanged.
2. While the next token is `;`: consume it, mark the input as pipeline-shaped, and (unless EOF follows — trailing `;` is allowed) collect another statement.
3. Expect EOF.
4. If no `;` was seen, return the single statement (`Expr` or `UpdateFilter`). Otherwise return a `Pipeline` whose `stmts` are the collected statements.

`parseUpdateFilterRest` only consumes `,` separators — `;` is a top-level boundary, never a update op-chain separator. Each tail update op goes through `parseUpdateOp()`, which calls `parsePostfix()` to read the next target. `parsePostfix()` may return a fully-formed `AssignExpr` if the user wrapped the assignment in parens (`($.a = 1)`) — formatters (prettier, oxfmt) emit this shape when an assignment chains with `,`. `parseUpdateOp` short-circuits on that case and returns the `AssignExpr` directly, so `($.a = 1), ($.b = 2)` coalesces into one `$set` stage just like the bare `$.a = 1, $.b = 2` form.

Inside `parseArrayLiteral`, the same per-element heuristic applies: a leading `Delete`/`++`/`--` token, or an expression followed by an assignment operator, becomes a update op element. This is what enables `[$match(...), $.a = 1, delete $.tmp, $sort(...)]`. Inside the bracketed form, `,` is the only separator (JS syntax).

### Chained `=` (right-associative)

`parseAssignmentChainFrom(target)` consumes the `=`, then peeks ahead with `peekIsAssignmentChainStart()` (DollarDot, identifier segments, dots, then an assignment operator). If it matches, parse the next target and recurse, then prepend the outer target with the deepest RHS as its value. The result is a flat list of `AssignExpr` nodes, all sharing the same RHS.

Compound operators (`+=`, etc.) reject chained RHS — too easy to misread.

### Target validation

A target must be a `FieldRef` or a chain of `MemberAccess` nodes rooted at one. Bare identifiers (`ParamRef`), index access (`IndexAccess`), and any other shape are rejected at parse time with operator-specific error messages. The walk lives in `Parser.isFieldPathTarget`.

### Compound desugar

For `$.a += rhs`, the parser emits:

```ts
{ type: "AssignExpr", target: <$.a>, value: { type: "BinaryExpr", op: "+", left: <$.a>, right: <rhs> } }
```

The `<$.a>` node is shared between `target` and `value.left` — the AST is immutable at codegen time, so sharing is safe. Compound `+`'s string-vs-number disambiguation (`$concat` vs `$add`) falls out of the existing `BinaryExpr +` codegen for free.

### Increment / decrement

`x++`, `++x`, `x--`, `--x` are sugar for `x += 1` and `x -= 1`. They desugar via `makeIncDecUpdateOp(target, op)` to the same `AssignExpr` shape as a compound assignment with a `NumberLiteral(1)` RHS. All four forms compile to the same `$set` stage — the prefix/postfix distinction (return-then-mutate vs mutate-then-return) is meaningful in JS but irrelevant in pipeline context where stage-level update ops have no return value.

Lexer adds `PlusPlus` and `MinusMinus` tokens with strict longest-match ordering: `++`/`--` is checked before `+=`/`-=` is checked before `+`/`-`. This means `1--2` (no whitespace) lexes as `1`, `--`, `2` and is rejected at target-validation; `1 - -2` (whitespace) lexes as `1`, `-`, `-`, `2` and parses as `1 - (-2)`.

Parser dispatch matches the rest of the update op surface:

- **Top level**: `parse()` adds `++`/`--` to the leading-token set that triggers `parseUpdateFilter` (alongside `delete`). Postfix is handled the same way as a leading assignment operator: after the speculative `parseExpression`, a `++`/`--` lookahead routes through `parseUpdateFilterFromPostfix(target)`.
- **`parseUpdateOp`**: prefix when the next token is `PlusPlus`/`MinusMinus`; postfix when the just-parsed target is followed by one.
- **`parseArrayLiteral`** (pipeline elements): same rules — prefix detected before parsing, postfix detected after.
- **`parseGrouped`**: `(++x)` and `(x++)` parsed via the same hooks. `(++x = 5)`-style nonsense fails through the existing path-validation errors.

Targets validate the same way as for assignments — only `FieldRef` or chained `MemberAccess`. `1++` and `$.items[0]++` are rejected at parse time; `1 + $.x++` falls through to the codegen-level "Assignment is a statement, not a value" error.

### Parenthesized assignments

Formatters wrap assignment expressions in parens when they appear in array element position (`[($.a = 5)]`). Without parser support, `jsmql(({ $ }) => [($.a = 5)])` would fail outside Vite/Vitest's transform (which silently strips the parens). To match user expectations, `parseGrouped` recognises an assignment-op after the inner expression: it parses the assignment chain inside the parens, validates the target, and returns the resulting `AssignExpr` cast as `Expr` (one localised type assertion). Single chains only — `($.a = $.b = 5)` is rejected with a precise error.

Downstream:

- **Top level**: the parser wraps a lone `AssignExpr` in a `UpdateFilter`, so `jsmql("($.a = 5)")` works identically to `jsmql("$.a = 5")` — a pipeline by the shape rule.
- **Pipeline element**: an array literal takes the write as an element (`[$.a = 1, $sort({ a: 1 })]`), and the write road coalesces it with its neighbours.
- **Inside a real expression** (`1 + ($.a = 5)`): a write is a statement, and the parser refuses the `=` where an expression is expected (`Expected ')' but got '='`).

## Lowering

Three roads read a write, by the program it stands in.

### The pipeline: `writeStages`

`writeStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) lowers a `,`-run of writes (`$.a = 1, $.b = 2`) to the fewest stages that keep JavaScript's left-to-right meaning. It walks the run and opens a new group when:

1. **The kind changes** — assignment ↔ delete. `delete $.a, $.b = 1, delete $.c` → `[{ $unset: "a" }, { $set: { b: 1 } }, { $unset: "c" }]`.
2. **A path collides** — the new write's path equals, contains or is contained by a path the group already writes. `$.a = 1, $.a = 2` → two `$set`s; so does `$.a.b = 1, $.a = {}`.
3. **A write reads what the group wrote** — `$.a = 1, $.b = $.a` → `[{ $set: { a: 1 } }, { $set: { b: "$a" } }]`, so `b` sees the new `a` exactly as JavaScript would. A `"$a"` the developer typed is the field `a` (HR1) and ends the group the same way.

Each group is one stage: `{ $set: { <path>: <value>, … } }`, or `{ $unset: "path" }` for one path and `{ $unset: ["a", "b"] }` for several — the string form is the shorter valid one. An object-literal value is emitted as `{ $mergeObjects: [<object>] }`, because a literal sub-document in `$set` MERGES into the existing field on the server where a JavaScript assignment replaces it ([emit-pass.md § the write road](emit-pass.md)). A `;` between writes is a stage boundary, never a same-stage separator.

`jsmql()` and `jsmql.pipeline()` return these stages; a lone write with no `;` is a pipeline by the shape rule ([filter-mode.md § The decision](filter-mode.md)). `jsmql.expr()` refuses a write, naming the two entries that take one.

### The update document: `lowerUpdate`

`jsmql.update()` lowers the same run through `lowerUpdate` in [src/compiler/emit/update.ts](../../src/compiler/emit/update.ts) to the update DOCUMENT `updateOne(filter, update)` takes — one key per update operator, constants only:

| Write | Operator |
|---|---|
| `$.a = <constant>` | `$set` |
| `$.n += k` / `-=` / `++` / `--` | `$inc` |
| `$.n *= k` | `$mul` |
| `delete $.a` | `$unset: { a: "" }` |
| `$.t = new Date()` | `$currentDate: { t: true }` |
| `$.n = Math.min($.n, k)` / `Math.max` | `$min` / `$max` |
| `$.tags.push(x)` / `.pop()` / `.shift()` | `$push` / `$pop` |
| `$inc({ n: 2 })`, `{ $set: { a: 1 } }` | merged in as written |

A value computed from the document is refused — the server reads `"$b"` in an update document as the string — with the pipeline form (`jsmql.pipeline("$.a = $.b + 1;")`), which `updateOne` accepts as well. Two writes to one path, and anything that is not a write or an update operator (a stage, `assert`, a stream chain), are refused too.

### Mutators and `Object.assign`

A mutating method at statement position — `$.tags.push(x)`, `$.items.sort()`, `$.s.trimStart()` — is the write it means: the desugar pass ([desugar-pass.md](desugar-pass.md)) rewrites a call whose row states a `mutatorForm` to the `AssignExpr` of its value form (`$.tags = $.tags.concat([x])`), and the roads above lower that. `Object.assign(target, …sources)` standing alone is JavaScript's mutating merge and is read the same way, on a field (`$.p` → `{ $set: { p: { $mergeObjects: ["$p", { a: 1 }] } } }`) and on a `let` binding (`Object.assign(p, …)` → a `$set` of the binding's slot); with a fresh object as the target (`Object.assign({}, $.a)`) it is a value. In an expression it is `$mergeObjects` throughout.

## Error message conventions

| Situation                       | Where caught | Message theme |
|---------------------------------|--------------|---------------|
| Bare identifier as target       | codegen      | A bare-identifier target is validated at codegen: in a pipeline it may reassign an in-scope `let` (see [let-bindings.md § Reassignment](let-bindings.md)); otherwise "Cannot assign to bare identifier 'x' …" |
| `IndexAccess` as target         | parser       | "Update op target must be a static field path; computed/index access ('[…]') is not supported" |
| Lambda or compound-shape target | parser       | "Update op target must be a field path like '$.x' or '$.x.y'" |
| Compound chain                  | parser       | "Compound assignment cannot be chained — split into separate statements" |
| Update op in a value array       | codegen      | "Assignment is a statement, not a value, and is only valid at the top level or as a pipeline-array element" |
| Empty update op program          | codegen      | "Update op program must contain at least one assignment or delete" (defensive — parser shouldn't produce this) |

`AssignExpr.pos` / `DeleteStmt.pos` are populated from the target's source offset (for `=`/`+=`/`-=`/`*=`/`/=`/`++`/`--`) or from the `delete` keyword (for `delete $.x`). Codegen forwards that offset into every update op-related error it raises, so the offending statement in a `;`-separated pipeline can be located precisely.

## Related

- [Let bindings](let-bindings.md) — `let x = ...` is sugar over update ops: it
  emits a `$set` per binding under a single compiler-owned namespace, with an
  auto-emitted trailing `$unset`. Use `let` when you want a temporary scratch
  value; use update ops (`$.x = ...`) when you want to persist `x` on the output
  document.

## Tests

- `test/compiler-statement.test.ts` (the pipeline) and `test/compiler-update.test.ts` (the update document) — one case per behaviour, each run on `mongod` and compared with JavaScript's answer.
- `test/realistic.test.ts` — at least one realistic end-to-end example combining update ops with pipeline-style usage.
