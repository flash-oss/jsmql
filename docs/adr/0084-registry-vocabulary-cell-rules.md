# 0084. The vocabulary types make every cell total over positions and receiver families

Status: Accepted
Applies to: `src/registry/vocabulary.ts`, `test/codegen.test.ts`

## Context

A row in `src/registry/names.ts` states one cell per position. A method can live on more than one receiver family, and its answer can differ by family. One flat answer per position then states a legality that one family does not have. For example, `.length` in filter position works for an array receiver and for a string receiver. The stream form `$$.size() > 1` cannot compile at all. The count needs a `$setWindowFields` stage, and a Filter holds no stage. One flat `viaFallback` would promise that the stream form only scans.

## Decision

- `Emitter` in `src/registry/vocabulary.ts` holds one rule for every family, or one rule per family under `perFamily`. Every family that `on` lists must appear, with a rule or with a refusal that says why. No family that `on` omits can appear. The count of arguments can differ by receiver: `$.n.round(2)` takes a precision, and the compiler refuses `Math.round(x)`, and both are the `round` entry.
- `byArgs` is a third dispatch axis beside position (`where`) and receiver (`on`). It dispatches on the argument shape. `ObjectId()` mints a value, `ObjectId("<hex>")` is a live BSON value, and `ObjectId($.id)` is `$toObjectId`: one name, one receiver, one position, and three different MQL.
- `Cell`: a position that `where` lists needs a real renderer, or `inCode(<the file that builds it>)`. A position that `where` omits needs a refusal with no escape hatch. So every claim about applicability is stated.
- `NonEmitter` answers per family too, under `perFamily`, for the reason above.
- The `C` generic of `Cell` carries the owners that a `composedInto` cell names. Without the generic, the cell erases to `{ composedInto: readonly string[] }`. An audit over the owners then passes but tests nothing, and an owner with no target stays invisible.
- A row states `returns` per family. The stream form of `.pick` and `.omit` is a `$project`, and the value form builds a document literal. So a value-position receiver of their result is an object. The compiler refuses a string, number or date method on it, because the server would stop the query.
- `on: "any"` opts a method out of the receiver check. `ANY_RECEIVER_BY_DESIGN` in `test/codegen.test.ts` lists each such method with its reason. A method that uses `"any"` to avoid a family fails that test, so it cannot emit MQL that the server rejects.

## Consequences

A new method row must state every family that `on` lists. A new type rule needs the `const` generic threading, or its audit tests nothing. A new `"any"` method needs an entry and a reason in `ANY_RECEIVER_BY_DESIGN`.
