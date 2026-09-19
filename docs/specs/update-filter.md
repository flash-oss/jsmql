# Update filters

How `=`, `+=`, `-=`, `*=`, `/=`, and `delete` lower from JavaScript syntax to MongoDB pipeline `$set` / `$unset` stages.

User-facing reference is `docs/LANGUAGE.md` § Update filters.

## AST

Three node types in `src/registry/ast.ts`:

The shapes are declared in [src/registry/ast.ts](../../src/registry/ast.ts):

```ts
type AssignExpr   = { type: "AssignExpr"; target: Expr; op: AssignOp; value: Expr; pos: number; mutates?: true };
type DeleteStmt   = { type: "DeleteStmt"; target: Expr; pos: number };
type UpdateOp     = AssignExpr | DeleteStmt;
type UpdateFilter = { type: "UpdateFilter"; ops: readonly UpdateOp[]; pos: number };
```

`AssignExpr` carries `op`, the spelling as WRITTEN. The desugar pass, not the parser,
reduces a compound operator to its `=` form: `$.a += rhs` becomes
`AssignExpr { op: "=", value: BinaryExpr("+", $.a, rhs) }`, so the emit phase only ever
sees `=`. The same pass sets `mutates` on a mutator's own write (`$.a.pop();`).
JavaScript allows this write on a `const` binding, and so does the emitter.

`UpdateFilter` is its own type, not part of the `Expr` union. `Parser.parse()` returns
`Program = Expr | UpdateFilter | Pipeline`, and `compile()` in `src/index.ts` dispatches
on the discriminant. `Pipeline` (from `aggregation-stages.md`) wraps a sequence of
`;`-separated top-level statements, and each statement is itself an `Expr` or an
`UpdateFilter`.

`ArrayElement` is `Expr | SpreadElement | LetDecl | FuncDecl | UpdateOp | UpdateFilter`,
so an update op can sit inside a pipeline-array literal. Non-pipeline `ArrayLiteral`
codegen rejects an update-op element with a clear error.

## Lexemes

Every lexeme these forms need — `=`, `+=`, `-=`, `*=`, `/=`, `;`, and the `delete`
keyword — is a ROW in [src/registry/tokens.ts](../../src/registry/tokens.ts) and
[src/registry/keywords.ts](../../src/registry/keywords.ts), the single source of
truth for them, and the lexer reads the tables and adds no name of its own. One rule
has no other home: a `/` after a value-ending token starts a division, so `/=` is
that operator, and everywhere else it opens a regular expression.

## Parser

A program is a `;`-separated statement loop. A statement is an `UpdateFilter` when it
starts with `delete`, `++` or `--`, or when its expression is followed by an
assignment operator. The `,` inside one continues the run and the `;` ends it. The
same per-element rule applies inside a bracketed pipeline (`[$match(…), $.a = 1,
delete $.tmp]`), where `,` is the only separator. A parenthesised assignment
(`($.a = 1), ($.b = 2)` — what a formatter writes) is read as the write it is, so it
coalesces exactly as the bare form does. See
[src/compiler/parse/parser.ts](../../src/compiler/parse/parser.ts).

### Chained `=` (right-associative)

`$.a = $.b = 1` writes one value to every target in the chain. It is not a nested
assignment: the parser reads each target while the lookahead keeps finding one
followed by an assignment operator, then builds a FLAT list of `AssignExpr` nodes
that all share the deepest right-hand side.

A compound operator (`+=`, and so on) rejects a chained right-hand side, because a
chain there is too easy to misread.

### Target validation

A target must be a `FieldRef` or a chain of `MemberAccess` nodes rooted at one. The
parser rejects an index access (`IndexAccess`) and every other shape at parse time,
and names the operator in the message. See
[src/compiler/parse/parser.ts](../../src/compiler/parse/parser.ts).

### Compound desugar

For `$.a += rhs`, the parser emits:

```ts
{ type: "AssignExpr", target: <$.a>, value: { type: "BinaryExpr", op: "+", left: <$.a>, right: <rhs> } }
```

The `<$.a>` node is shared between `target` and `value.left`, because the AST stays
immutable at codegen time, so sharing is safe. Compound `+`'s string-vs-number
disambiguation (`$concat` vs `$add`) falls out of the existing `BinaryExpr +` codegen
for free.

### Increment / decrement

`x++`, `++x`, `x--`, `--x` are sugar for `x += 1` and `x -= 1`. Each one desugars
through `makeIncDecUpdateOp(target, op)` to the same `AssignExpr` shape as a compound
assignment with a `NumberLiteral(1)` right-hand side. All four forms compile to the
same `$set` stage. The prefix/postfix distinction (return then mutate, or mutate then
return) matters in JavaScript, but not in a pipeline, where a stage-level update op
returns no value.

`++` and `--` are rows in [src/registry/tokens.ts](../../src/registry/tokens.ts) like
every other lexeme, and the lexer derives the punctuator order from key length, so it
matches `++` before `+=` before `+`. `1--2` (no whitespace) therefore lexes as `1`,
`--`, `2`, and target validation rejects it, while `1 - -2` lexes as `1`, `-`, `-`,
`2` and parses as `1 - (-2)`.

Both spellings mean one write, so both reach the same road. At the top level, inside a
bracketed pipeline, and inside parentheses, a leading `++`/`--` opens an update run and
a trailing one closes it over the target just read.

A target here validates the same way as for an assignment: only a `FieldRef` or a
chained `MemberAccess`. `1++` and `$.items[0]++` are rejected at parse time; `1 + $.x++`
falls through to the codegen-level "Assignment is a statement, not a value" error.

### Parenthesized assignments

A formatter wraps an assignment expression in parens when it appears in array element
position (`[($.a = 5)]`). Without parser support, `jsmql(({ $ }) => [($.a = 5)])` would
fail outside Vite's or Vitest's transform, which silently strips the parens. To match
what a user expects, `parseGrouped` recognises an assignment operator after the inner
expression. It parses the assignment chain inside the parens, validates the target, and
returns the resulting `AssignExpr` cast as `Expr` (one localised type assertion). It
accepts a single chain only — `($.a = $.b = 5)` is rejected with a precise error.

Downstream:

- **Top level**: the parser wraps a lone `AssignExpr` in an `UpdateFilter`, so
  `jsmql("($.a = 5)")` works the same way as `jsmql("$.a = 5")` — a pipeline by the
  shape rule.
- **Pipeline element**: an array literal takes the write as an element
  (`[$.a = 1, $sort({ a: 1 })]`), and the write road coalesces it with its neighbours.
- **Inside a real expression** (`1 + ($.a = 5)`): a write is a statement, and the
  parser refuses the `=` where an expression is expected (`Expected ')' but got '='`).

## Lowering

Three roads read a write, chosen by the program it stands in.

### The pipeline: `writeStages`

`writeStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)
lowers a `,`-run of writes (`$.a = 1, $.b = 2`) to the fewest stages that keep
JavaScript's left-to-right meaning. It walks the run and opens a new group when:

1. **The kind changes** — assignment ↔ delete. `delete $.a, $.b = 1, delete $.c` →
   `[{ $unset: "a" }, { $set: { b: 1 } }, { $unset: "c" }]`.
2. **A path collides** — the new write's path equals, contains or sits inside a path
   the group already writes. `$.a = 1, $.a = 2` → two `$set`s; so does
   `$.a.b = 1, $.a = {}`.
3. **A write reads what the group wrote** — `$.a = 1, $.b = $.a` →
   `[{ $set: { a: 1 } }, { $set: { b: "$a" } }]`, so `b` sees the new `a` exactly as
   JavaScript would. A `"$a"` the developer typed is the field `a` (HR1) and ends the
   group the same way.

Each group is one stage: `{ $set: { <path>: <value>, … } }`, or `{ $unset: "path" }`
for one path and `{ $unset: ["a", "b"] }` for several — the string form is the shorter
valid one. The emitter writes an object-literal value as `{ $mergeObjects: [<object>] }`,
because a literal sub-document in `$set` MERGES into the existing field on the server,
where a JavaScript assignment replaces it ([emit-pass.md § the write road](emit-pass.md)).
A `;` between writes is always a stage boundary, never a same-stage separator.

`jsmql()` and `jsmql.pipeline()` return these stages; a lone write with no `;` is a
pipeline by the shape rule ([filter-mode.md § The decision](filter-mode.md)).
`jsmql.expr()` refuses a write, and names the two entries that take one.

### The update document: `lowerUpdate`

`jsmql.update()` lowers the same run through `lowerUpdate` in
[src/compiler/emit/update.ts](../../src/compiler/emit/update.ts) to the update
DOCUMENT that `updateOne(filter, update)` takes: one key per update operator,
constants only.

| Write | Operator |
|---|---|
| `$.a = <constant>` | `$set` |
| `$.n += k` / `-=` / `++` / `--` | `$inc` |
| `$.n *= k` | `$mul` |
| `delete $.a` | `$unset: { a: "" }` |
| `$.t = new Date()` | `$currentDate: { t: true }` |
| `$.n = Math.min($.n, k)` / `Math.max` | `$min` / `$max` |
| `$.tags.push(x)` / `.pop()` / `.shift()` | `$push` / `$pop` |
| `$.b = $.a` paired with `delete $.a`, either order | `$rename` |
| `$inc({ n: 2 })`, `{ $set: { a: 1 } }` | merged in as written |

The lowering refuses a value computed from the document, because the server reads
`"$b"` in an update document as the string. The pipeline form
(`jsmql.pipeline("$.a = $.b + 1;")`), which `updateOne` also accepts, is the
alternative to name. The rename pair above is the one read of the document that a
document-form update takes, because `$rename` names the source field rather than
evaluating it. A value the server computes without reading the document (`new Date()`
inside a value, `ObjectId()`, `Date.now()`) is refused by its row's `updateDoc` cell,
which names the write that does exist (`$.<field> = new Date()` is `$currentDate`) and
the pipeline form. A row without that cell gets the position's general sentence from
`refusalFor` in [src/compiler/emit/errors.ts](../../src/compiler/emit/errors.ts). The
lowering also refuses two writes to one path, and anything that is not a write or an
update operator, such as a stage, `assert`, or a stream chain.

### Mutators and `Object.assign`

A mutating method at statement position — `$.tags.push(x)`, `$.items.sort()`,
`$.s.trimStart()` — is the write it means. The desugar pass
([desugar-pass.md](desugar-pass.md)) rewrites a call whose row states a `mutatorForm`
to the `AssignExpr` of its value form (`$.tags = $.tags.concat([x])`), and the roads
above lower that. `Object.assign(target, …sources)` standing alone is JavaScript's
mutating merge, and JSMQL reads it the same way: on a field (`$.p` →
`{ $set: { p: { $mergeObjects: ["$p", { a: 1 }] } } }`) and on a `let` binding
(`Object.assign(p, …)` → a `$set` of the binding's slot). With a fresh object as the
target (`Object.assign({}, $.a)`), it is a value. In an expression it is
`$mergeObjects` throughout.

## Error message conventions

| Situation                       | Where caught | Message theme |
|---------------------------------|--------------|---------------|
| Bare identifier as target       | codegen      | A bare-identifier target is validated at codegen: in a pipeline it may reassign an in-scope `let` (see [let-bindings.md § Reassignment](let-bindings.md)); otherwise "Cannot assign to bare identifier 'x' …" |
| `IndexAccess` as target         | parser       | "Update op target must be a static field path; computed/index access ('[…]') is not supported" |
| Lambda or compound-shape target | parser       | "Update op target must be a field path like '$.x' or '$.x.y'" |
| Compound chain                  | parser       | "Compound assignment cannot be chained — split into separate statements" |
| Update op in a value array       | codegen      | "Assignment is a statement, not a value, and is only valid at the top level or as a pipeline-array element" |
| Empty update op program          | codegen      | "Update op program must contain at least one assignment or delete" (defensive — parser should not produce this) |

`AssignExpr.pos` / `DeleteStmt.pos` come from the target's source offset (for
`=`/`+=`/`-=`/`*=`/`/=`/`++`/`--`) or from the `delete` keyword (for `delete $.x`).
Codegen forwards that offset into every update-op-related error it raises, so a
reader can locate the offending statement in a `;`-separated pipeline precisely.

## Related

- [Let bindings](let-bindings.md) — `let x = ...` is sugar over update ops: it
  emits a `$set` per binding under a single compiler-owned namespace, with an
  auto-emitted trailing `$unset`. Use `let` for a temporary scratch value; use an
  update op (`$.x = ...`) to persist `x` on the output document.

## Tests

- `test/compiler-statement.test.ts` (the pipeline) and `test/compiler-update.test.ts`
  (the update document) — one case per behaviour, each run on `mongod` and compared
  with JavaScript's answer.
- `test/realistic.test.ts` — at least one realistic end-to-end example that combines
  update ops with pipeline-style usage.
