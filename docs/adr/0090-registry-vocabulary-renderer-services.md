# 0090. The contracts of the services that a renderer receives

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

A cell gets services through `FilterIn`, `ExprIn` and `StageIn`, and never imports the compiler. Each service has a contract that a cell relies on.

## Decision

- `FilterIn.recv` is the receiver as SOURCE, because a filter renders field paths, not lowered values.
- `pathOf` gives the field path (`"a.b.c"`) or null. An index, a call, `.length` and a computed key are not plain paths. Inside a `.some` callback the element parameter is the root, so `i.q` is the path `"q"`.
- `constant` gives a boxed value that the QUERY language compares as written (a number, a string, a boolean, null, a Date, an ObjectId). The box keeps a constant `null` apart from "not constant". It is null for an array (the server matches elements), a regex, a bigint, a document or an expression.
- `elementQuery` gives the body of a one-parameter callback as the `$elemMatch` query over each ELEMENT, or null when any part has no native form.
- `orMissing`: the clause for a test that holds for the receiver's safe value (HR5). Under a dot a missing or null receiver reads as that value, so the clause also matches a missing or null field. After a `?.` the call gives null, so the clause has no null test. A `?.` earlier in the path gives null only where its own link is missing. The answer is then null, and the cell takes the expression road.
- `kind` gives the proven kind of an ARGUMENT. MEASURED: the server optimiser folds a run of ADJACENT constant operands inside `$concat` and `$concatArrays`. It raises an error there when a folded constant has the wrong type, before any `$switch` branch. A guard cannot stop it, so the cell renders such an argument as JavaScript renders it.
- `type` gives the whole proof of an argument. `.concat(x)` splices `x` when the proof shows a present array, wraps `[x]` when it shows no array, and tests `$isArray` when only the run decides.
- `present` is true when the receiver is never null or missing. Such a receiver is, for example, a `$lookup` array, a literal, `$range(…)` or the root keys. It can also be a chain of `neverNull` rows over these, or a family-dispatch branch that its `$type` test proves. A cell whose operator stops on null (`$size`, `$in`, the input of `$map`) wraps its receiver in `$ifNull` unless this is true. MEASURED: `{ $size: null }` stops the whole command, and every array operator gives null for a missing field.
- `elementTruth`: JavaScript truthiness of one element. The element's proof drops each test that the element cannot fail; an object-or-null element takes the null test alone.
- `callback`: an array callback `(x[, i[, arr]])`. When the body reads the index, the input becomes the `[i, x]` pairs (`$zip` with a `$range`). `paired` says so, and a cell that gives an element unwraps it.
- `objIteratee`: a callback over the `{ k, v }` pairs of a document, with a `$let` that binds `v` and `k`. In truth mode the body uses the JavaScript truth rules.
- `reducer`: the accumulator reads `$$value` and the element `$$this`. An index makes the input the `[i, x]` pairs and the body a `$let`.
- `construct`: the server has no expression that builds some BSON values, so the live value goes into the MQL as itself. The compiler throws `refusal` at the call for a constant that the type cannot hold, so the cell never sees a null.
- `SortAsk`: keys by name, or a COMPUTED key (`d => d.cat.toLower()`). MongoDB cannot sort by a computed key, so the cell writes it to a scratch field and sorts by that field. `StageSortAsk` excludes the `whole` element, because a `$sort` stage needs a field name.
- `StageIn.predicate` is total: a body with no native form arrives as `{ $expr: … }`. The parameter IS the document.
- `StageIn.document` refuses a body that the registry proves is not a document (`d => 5`), because the server refuses every root that is not a document.
- `StageIn.sortSpec` with `objects: false` refuses the spec form where the method reads an object as a lodash matcher (`.sortBy`).
- `MutatorForm`: a mutator's statement as JSMQL source, by argument count. `_r` is the receiver, and `_0`, `_1` are the arguments. `$.a.pop();` with `{ 0: "[..._r].slice(0, -1)" }` becomes `$.a = [...$.a].slice(0, -1);`. The form spreads the receiver into an array literal, because `.pop()` exists on an array alone. The value cells then take the array branch with no runtime dispatch. `[...$.a]` lowers to `"$a"`. The source form shows exactly what the statement means and reaches the same cells as a developer's spelling.

## Consequences

A new service states its null and totality contract on its type. A cell reads the service and never reimplements it.
