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

## Adding a feature

1. Write one declaration in the family file.
2. Answer every applicable cell. Where the answer is no, write the reason a user
   will read.
3. For a predicate-shaped feature, point the Query cell at a Predicate IR node
   rather than a hand-written query lowering. See
   [predicate-ir.md](predicate-ir.md).
4. Add a test case. Verify the emitted MQL on a running `mongod` — a passing
   `toEqual` proves what jsmql emits, never that the server accepts it.
