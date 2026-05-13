# Mutations

How `=`, `+=`, `-=`, `*=`, `/=`, and `delete` lower from JavaScript syntax to MongoDB pipeline `$set` / `$unset` stages.

User-facing reference is `docs/LANGUAGE.md` § Mutations.

## AST

Three node types in `src/ast.ts`:

```ts
type AssignExpr      = { type: "AssignExpr"; target: Expr; value: Expr };
type DeleteStmt      = { type: "DeleteStmt"; target: Expr };
type Mutation        = AssignExpr | DeleteStmt;
type MutationProgram = { type: "MutationProgram"; mutations: Mutation[] };
```

`AssignExpr` does not carry an `op` field. The parser desugars compound operators (`+=`, `-=`, `*=`, `/=`) at construction time: `$.a += rhs` becomes `AssignExpr { target: $.a, value: BinaryExpr("+", $.a, rhs) }`. Codegen therefore only sees plain `=` assignments.

`MutationProgram` is its own type, not part of the `Expr` union. `Parser.parse()` returns `Program = Expr | MutationProgram | Pipeline`; `compile()` in `src/index.ts` dispatches on the discriminant. `Pipeline` (from `aggregation-stages.md`) wraps a sequence of `;`-separated top-level statements where each statement is itself an `Expr` or a `MutationProgram`.

`ArrayElement` is widened to `Expr | SpreadElement | AssignExpr | DeleteStmt` so mutations can sit inside pipeline-array literals. Non-pipeline `ArrayLiteral` codegen rejects mutation elements with a clear error.

## Lexer

Six new tokens (`src/lexer.ts`):

| Token       | Source | Notes |
|-------------|--------|-------|
| `Eq`        | `=`    | Distinct from `EqEq` / `EqEqEq` / `Arrow` (longer-token-first ordering preserved) |
| `PlusEq`    | `+=`   | Two-char lookahead before single-char `Plus` |
| `MinusEq`   | `-=`   | Same as above for `Minus` |
| `StarEq`    | `*=`   | Checked after `**` (StarStar) and before `*` (Star) |
| `SlashEq`   | `/=`   | Only emitted in division-context (`lastTokenType` is value-ending). In regex-context, the `=` after `/` is part of a regex literal. |
| `Semi`      | `;`    | Top-level pipeline-stage separator (see `aggregation-stages.md` § Implicit `;`-separated form). Not consumed by `parseMutationProgramRest`. |

One new keyword: `Delete` (added to `keywordToken()` switch alongside `typeof`/`new`/`in`).

## Parser

Top-level dispatch (`Parser.parse()`) is a `;`-separated statement loop, not a single dispatch:

1. Collect the first statement via `collectStatement()`. Inside that helper:
   1. If the first token is `Delete`, `++`, or `--` → `parseMutationProgram()` directly.
   2. Otherwise speculatively `parseExpression()`. If an assignment operator follows, the expression is the first mutation target; flow merges into `parseMutationProgramFrom(target)`. If a postfix `++`/`--` follows, route through `parseMutationProgramFromPostfix(target)`.
   3. Otherwise return the expression unchanged.
2. While the next token is `;`: consume it, mark the input as pipeline-shaped, and (unless EOF follows — trailing `;` is allowed) collect another statement.
3. Expect EOF.
4. If no `;` was seen, return the single statement (`Expr` or `MutationProgram`). Otherwise return a `Pipeline` whose `stmts` are the collected statements.

`parseMutationProgramRest` only consumes `,` separators — `;` is a top-level boundary, never a mutation-chain separator.

Inside `parseArrayLiteral`, the same per-element heuristic applies: a leading `Delete`/`++`/`--` token, or an expression followed by an assignment operator, becomes a mutation element. This is what enables `[$match(...), $.a = 1, delete $.tmp, $sort(...)]`. Inside the bracketed form, `,` is the only separator (JS syntax).

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

`x++`, `++x`, `x--`, `--x` are sugar for `x += 1` and `x -= 1`. They desugar via `makeIncDecMutation(target, op)` to the same `AssignExpr` shape as a compound assignment with a `NumberLiteral(1)` RHS. All four forms compile to the same `$set` stage — the prefix/postfix distinction (return-then-mutate vs mutate-then-return) is meaningful in JS but irrelevant in pipeline context where stage-level mutations have no return value.

Lexer adds `PlusPlus` and `MinusMinus` tokens with strict longest-match ordering: `++`/`--` is checked before `+=`/`-=` is checked before `+`/`-`. This means `1--2` (no whitespace) lexes as `1`, `--`, `2` and is rejected at target-validation; `1 - -2` (whitespace) lexes as `1`, `-`, `-`, `2` and parses as `1 - (-2)`.

Parser dispatch matches the rest of the mutation surface:

- **Top level**: `parse()` adds `++`/`--` to the leading-token set that triggers `parseMutationProgram` (alongside `delete`). Postfix is handled the same way as a leading assignment operator: after the speculative `parseExpression`, a `++`/`--` lookahead routes through `parseMutationProgramFromPostfix(target)`.
- **`parseMutation`**: prefix when the next token is `PlusPlus`/`MinusMinus`; postfix when the just-parsed target is followed by one.
- **`parseArrayLiteral`** (pipeline elements): same rules — prefix detected before parsing, postfix detected after.
- **`parseGrouped`**: `(++x)` and `(x++)` parsed via the same hooks. `(++x = 5)`-style nonsense fails through the existing path-validation errors.

Targets validate the same way as for assignments — only `FieldRef` or chained `MemberAccess`. `1++` and `$.items[0]++` are rejected at parse time; `1 + $.x++` falls through to the codegen-level "Assignment is a statement, not a value" error.

### Parenthesized assignments

Formatters wrap assignment expressions in parens when they appear in array element position (`[($.a = 5)]`). Without parser support, `jsmql(($) => [($.a = 5)])` would fail outside Vite/Vitest's transform (which silently strips the parens). To match user expectations, `parseGrouped` recognises an assignment-op after the inner expression: it parses the assignment chain inside the parens, validates the target, and returns the resulting `AssignExpr` cast as `Expr` (one localised type assertion). Single chains only — `($.a = $.b = 5)` is rejected with a precise error.

Downstream:

- **Top level**: `parse()` checks for `expr.type === "AssignExpr"` after `parseExpression` returns and wraps it in a `MutationProgram`. So `jsmql("($.a = 5)")` works identically to `jsmql("$.a = 5")`.
- **Pipeline element**: `parseArrayLiteral` already pushes whatever `parseExpression` returns; `ArrayElement` allows `AssignExpr`; `pipeline.ts` `isStageCandidate` returns true for it; the coalescer takes over.
- **Inside a real expression** (e.g. `1 + ($.a = 5)`): the AssignExpr bubbles through the cascade and eventually reaches `_generateBody`. A defensive check at the top of that function throws `CodegenError("Assignment is a statement, not a value …")` with a clear, actionable message.

## Codegen

`src/codegen.ts` exports two mutation entry points:

- `generateMutationProgram(prog)` — top-level entry from `compile()`. Emits a single stage object (one group) or a stage array (2+ groups), matching the existing 1-stage-vs-pipeline output convention.
- `generateMutationGroups(muts)` — used by `pipeline.ts` when mutations appear inline in a pipeline array. Returns an array of stage objects without the unwrap step.

### Coalescing

`groupMutations(muts)` walks the list left-to-right and starts a new group when:

1. **Kind change** — assignment ↔ delete.
2. **Path collision** — the new write path equals or is a parent/child of any prior write in the group (detected by `pathsCollide`, which compares dotted strings).
3. **Read-after-write** (assignments only) — the new RHS reads any path the current group has written. Reads are collected by `collectMutationReads(expr)`, which walks all expression node types and records every foldable field path (`tryFieldPath` reconstructs dotted strings the same way `asFieldPath` does, but without the leading `$`).

Each group emits one stage:

- All-`AssignExpr` group → `{ $set: { writePath: gen(value), … } }`
- All-`DeleteStmt` group → `{ $unset: "path" }` (size 1) or `{ $unset: ["a", "b", …] }` (size 2+). MongoDB pipeline `$unset` accepts both shapes; the string form is more compact and matches handwritten output.

The codegen never inspects the original compound operator — by the time it runs, `+=` has been desugared to `=` plus `BinaryExpr`. This keeps `_generate`'s switch simple and lets the existing arithmetic codegen handle type-aware `$add`/`$concat` etc.

## Pipeline integration

There are two pipeline forms, with one important behavioural difference:

- **Bracketed `[…]`** — `isStageCandidate` in `src/pipeline.ts` returns true for `AssignExpr` and `DeleteStmt`, so a pipeline whose first element is a bare mutation (`[$.a = 1, $sort({a: 1})]`) is still detected as a pipeline. `generatePipeline` walks elements left-to-right with a `mutationBuffer`. Consecutive mutation elements accumulate; non-mutation stages flush the buffer through `generateMutationGroups` (so the same coalescing rule that runs at the top level also runs between pipeline stages) and then push their own compiled stage.
- **Implicit `;`-separated** — `generateImplicitPipeline` in `src/pipeline.ts` lowers each `;`-separated statement in isolation. A `MutationProgram` chunk goes through `generateMutationProgram` (which already handles RAW splits inside its `,`-grouped chain); a stage expression goes through the same single-element path used for bracketed pipelines. Adjacent mutation statements **never** coalesce across `;` — the boundary is hard. Comma-grouped mutations inside one `;` chunk still coalesce via the usual rules.

## Error message conventions

| Situation                       | Where caught | Message theme |
|---------------------------------|--------------|---------------|
| Bare identifier as target       | parser       | "Mutation target must be a field path like '$.x', not a bare identifier" |
| `IndexAccess` as target         | parser       | "Mutation target must be a static field path; computed/index access ('[…]') is not supported" |
| Lambda or compound-shape target | parser       | "Mutation target must be a field path like '$.x' or '$.x.y'" |
| Compound chain                  | parser       | "Compound assignment cannot be chained — split into separate statements" |
| Mutation in a value array       | codegen      | "Assignment is a statement, not a value, and is only valid at the top level or as a pipeline-array element" |
| Empty mutation program          | codegen      | "Mutation program must contain at least one assignment or delete" (defensive — parser shouldn't produce this) |

## Related

- [Let bindings](let-bindings.md) — `let x = ...` is sugar over mutations: it
  emits a `$set` per binding under a single compiler-owned namespace, with an
  auto-emitted trailing `$unset`. Use `let` when you want a temporary scratch
  value; use mutations (`$.x = ...`) when you want to persist `x` on the output
  document.

## Tests

- `test/mutations.test.ts` — focused unit tests, one case per behavior.
- `test/realistic.test.ts` — at least one realistic end-to-end example combining mutations with pipeline-style usage.
