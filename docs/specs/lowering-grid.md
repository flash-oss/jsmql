# The lowering grid

## Overview

Every jsmql feature is one declaration. The declaration states what the feature
is and how it lowers into each MQL language that can reach it. Nothing about a
feature lives anywhere else.

The grid exists for one reason: **a feature added to one cell and not to its
sibling must break the build.** Everything below serves that.

For the three target languages and the two receiver kinds, see
[architecture.md](architecture.md).

## One declaration

```ts
take: {
  receiver: "array",
  returns:  "array",
  args:     { sig: "n", exact: 1, type: "int>=0" },
  value:    (recv, [n]) => ({ $slice: [recv, n] }),
  stage:    ([n])       => [{ $limit: n }],
  query:    unsupported("not a predicate"),
}
```

| Field | Owns |
|---|---|
| `receiver` | the receiver family. Decides which cells are applicable, gates the chain type-check, and picks the interface the generated TypeScript augments. |
| `returns` | the result type. Drives type inference and the chain type-check's view of this feature as a receiver. |
| `args` | arity, argument names, and the literal type gate. One rule, read by the compile-time check **and** by the TypeScript signature generator. |
| `value` | the Expr cell. |
| `stage` | the Stage cell. |
| `query` | the Query cell — usually a Predicate IR node rather than a hand-written lowering. |

The single `args` rule is what keeps the editor and the compiler in agreement.
A signature written by hand beside a check written by hand is two statements of
one fact, and two statements drift.

## Applicability is derived

`receiver` decides which cells a feature can have. A string receiver never has a
Stage cell, because the stream is a sequence of documents and not a string. So
no declaration is asked to answer a cell that cannot exist.

| `receiver` | Value | Stage | Query |
|---|---|---|---|
| `string` | applicable | never | applicable when `returns: "bool"` |
| `array` | applicable | applicable | applicable when `returns: "bool"` |
| `number` / `object` / `date` | applicable | never | applicable when `returns: "bool"` |

## Every applicable cell must be answered

An applicable cell holds a lowering or `unsupported(reason)`. An unanswered
applicable cell fails the build.

`unsupported` is not a gap. It is the recorded answer, and it carries the
message the user sees:

```ts
sum: {
  receiver: "array",
  returns:  "number",
  value:    (recv, [it]) => …,
  stage:    unsupported("'.sum(...)' returns a single value, not a stream — it collapses '$$' to one value, so it's only valid in a VALUE position"),
  query:    unsupported("not a predicate"),
}
```

A reason that cannot be written convincingly is a gap that has just announced
itself. That is the mechanism by which the grid finds missing features, and it
is why a generic catch-all message is not an acceptable substitute.

## Four kinds, one vocabulary

The same model covers every feature kind. Only the applicable cells differ.

| Kind | Declares |
|---|---|
| JS method | all fields above |
| Operator | `args`, `returns`, the operator shape, and its position constraint |
| Stage | `args`, placement rules, and its sub-pipeline fields |
| Sugar form | its trigger shape and the node the desugar pass rewrites it into |

`args` is one vocabulary across all four. The rules it can express —
arity, required and optional keys, enums, integer bounds, closed key sets,
mutual exclusion — are stated once and applied by one checker.

Rules stay **literal-gated**. A validator inspects fully-static shapes only and
stays silent wherever an expression fills the slot, so it rejects certain
violations and never a shape some deployment accepts. See
[pipeline-validation.md](pipeline-validation.md) and
[operator-validation.md](operator-validation.md).

## Where declarations live

One file per family, assembled into one registry at import:

```
src/methods/string.ts      src/methods/array.ts       src/methods/lodash-array.ts
src/methods/object.ts      src/methods/date.ts        src/methods/number.ts   …
```

One file per kind would recreate the single large file this structure replaces,
and concurrent work would collide in it. One file per feature would scatter the
family-level facts that a family file states once.

The assembly point carries a completeness test: every family file must be
imported. A family file nobody imports is silently absent, which is the same
class of failure the grid removes everywhere else.

## The tests that hold it up

| Test | Asserts |
|---|---|
| grid completeness | every applicable cell of every declaration holds a lowering or `unsupported` |
| family assembly | every family file reaches the registry |
| signature agreement | the generated TypeScript signature matches the `args` rule it came from |
| value/stream parity | for a dual-declared feature, the two cells agree on which elements and what shape (`test/parity.test.ts`) |
| spec reconciliation | every difference from the vendored MQL spec is explicitly marked |

Parity is contracted on element identity and shape, **not on order**. Where a
JavaScript or lodash runtime carries an ordering guarantee the developer never
wrote, jsmql takes MongoDB's behaviour and the smaller MQL. See the axiom in
[../LANG_RULES.md](../LANG_RULES.md).

## Migration state

The grid is being filled family by family. `generateMethodCall` consults it before its
switch, so a declared method never reaches the switch and an un-declared one is untouched.

What is left in the switch is no longer a backlog of un-done families — it is one shape the
grid cannot yet express, plus four methods that need a service nobody else needs:

| Left in the switch | Why |
|---|---|
| `.indexOf` `.includes` `.at` `.slice` `.concat` `.nth` `.lastIndexOf` `.size` `.toString` `.toLocaleString` | DUAL-receiver. Each works on a string AND an array (or an array and an object), and picks its lowering from what the receiver is inferred to be. The family they would declare is not one of the five. |
| `.reduce` `.reduceRight` | The accumulator's type is narrowed from the initial value AND the lambda's result together, which no resolved value can carry. |
| `.findIndex` `.findLastIndex` | They build their own `$zip`-and-`$reduce` scan instead of going through the shared callback resolver. |
| `.zipWith` | Its iteratee takes one parameter per zipped ARRAY, so the one-parameter resolver cannot serve it. |
| `.join` | Reads its RECEIVER's shape to reject a nested array. |
| `.clamp` | Its receiver may be a number OR a date — again no single family. |
| `.test` `.exec` `.isSubsetOf` `.isSupersetOf` | Intercepted on a RegExp / Set receiver before `generateMethodCall`, so they never reach the grid. |

The dual-receiver row is the one worth solving, because it is ten of the twenty and it is a
missing CONCEPT rather than a missing service: `receiver` names one family, and these
methods have two.

`test/methods-grid.test.ts` carries a **ratchet**: the number of methods still lowering
from the switch may only fall. A rise means a method was added to the switch instead of a
family file — the habit the grid exists to break. The same test fails if the ratchet drifts
more than five above the real count, so it cannot quietly become decoration. Delete it when
the count reaches zero.

| Family | File | Methods |
|---|---|---|
| date accessors | `src/methods/date-accessors.ts` | 16 |
| date (arithmetic / compare / format / parts) | `src/methods/date.ts` | 18 |
| string | `src/methods/string.ts` | 22 |
| number | `src/methods/number.ts` | 4 |
| object (key/value reshapers) | `src/methods/object.ts` | 8 |
| lodash string (case/word) | `src/methods/lodash-string.ts` | 9 |
| lodash array (value vocabulary) | `src/methods/lodash-array.ts` | 33 |
| array shims (mutators / iterators) | `src/methods/array-shims.ts` | 14 |
| array slicing / zip | `src/methods/array-slicing.ts` | 16 |
| array callbacks | `src/methods/array-callbacks.ts` | 7 |
| array reshape (immutable copies / sorts) | `src/methods/array-reshape.ts` | 6 |

`src/methods/` holds **method families and nothing else** — that is what lets the assembly
test compare the directory to the registry directly. Shared MQL shape-builders live beside
it, not inside it: `src/mql-shape.ts` (generic — `cond`, the index clamps, the literal
readers), `src/mql-string.ts` (string-specific), `src/mql-array.ts` (array-specific,
plus the resolved-iteratee shape the array family reads), `src/mql-date.ts` and
`src/mql-sort.ts`.

Each family file is a **leaf**: it imports only its own types and other leaves. What a
lowering needs from the compiler arrives through `LowerInput` as a **service**, never as an
import:

| Service | For |
|---|---|
| `gen(expr)` | lower an argument |
| `internalVar(base)` | mint a variable name that cannot capture a user parameter |
| `err(message, pos?)` | reject, with a caret — importing `CodegenError` would create the cycle |
| `iteratee(node?)` | resolve a lodash iteratee — it lowers a lambda body against a scope binding the element, which only the compiler holds |
| `predicate(node)` | the same vocabulary read as a boolean |
| `objIteratee(node)` | resolve a `(value[, key])` iteratee over `$objectToArray` entries |
| `callback()` | resolve this call's JavaScript array callback, `(element[, index[, array]]) => …` |

A leaf HELPER module throws `CodegenError` directly — `src/errors.ts` is a leaf too, and a
helper reading an AST node always has that node's `pos` to hand. `err` exists for the other
case: a declaration that wants the CALL position defaulted for it.

A resolved iteratee carries its own `innerVar`, for a binding read from *inside* the element
binding: the user's iteratee parameter is in scope there, so a bare name would capture it.
Putting the scoped minter on the iteratee is what stops a call site from forgetting the
extra scope — four of them used to spell it out by hand.

Add a service only when a lowering genuinely cannot be written without it. `LowerInput`
becoming a grab-bag is the failure `GenerateCtx` already demonstrated. A family file that reaches
back into `codegen.ts` creates a cycle, and the registry then assembles before the family
initialises — the lookup silently returns nothing and every method in that file falls
through to the switch. Express what a lowering needs through `LowerInput` instead.

**A helper that takes a `GenerateCtx` usually wants one function out of it.** The slice-index
resolvers read an AST node *and* lower it, which reads like a codegen dependency. What they
need is `_generate` bound to the live scope, so they take a `Gen` — the same
`(node) => unknown` shape `LowerInput.gen` has — and live at leaf level where a family can
reach them. `genIn(ctx)` in `codegen.ts` is the binder. Check for this before concluding a
lowering cannot be declared.

A migration must not change output. The differential harness is the check — moving where a
lowering lives is not licence to move what it emits, and a divergence from a migration
commit is a bug until proven otherwise.

## Adding a feature

1. Write one declaration in the family file.
2. Answer every applicable cell. Where the answer is no, write the reason a user
   will read.
3. For a predicate-shaped feature, point the Query cell at a Predicate IR node
   rather than a hand-written query lowering. See
   [predicate-ir.md](predicate-ir.md).
4. Add a test case. Verify the emitted MQL on a running `mongod` — a passing
   `toEqual` proves what jsmql emits, never that the server accepts it.
