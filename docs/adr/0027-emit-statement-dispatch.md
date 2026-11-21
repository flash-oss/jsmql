# 0027. How the statement target routes a statement, a chain link and a stage body

Status: Accepted
Applies to: `src/compiler/emit/statement.ts`

## Context

A statement can be a stage call, a raw stage document, a chain on a context reference, a mutator or a function call. `stageStatement`, `streamLink`, `peels`, `refStatement` and `stageBody` in `src/compiler/emit/statement.ts` route each form to its road. A wrong route emits a valid-looking stage on the wrong collection, or a refusal with the wrong words. The specs state the main rules (emit-pass.md § The statement target, aggregation-stages.md, stream-methods.md § Bare-statement stream chains). This record keeps the smaller decisions that no spec states.

## Decision

- `stageBody` walks a stage body whose row states a layout. It reads `$geoNear`'s `query` as a query document and `$lookup`'s `pipeline` as stages. The walk is in `stageBody` and not in `lowerValue`, because only these two readings are not values. A value lowering that could answer a query document would need to know both readings.
- A statement that names something asks the row, and the row's own cell renders it. The compiler does not ask `isStageName`. `assert(…)` is a statement and not a stage, so that question would refuse it with the wrong word.
- `pipelineBody` merges the outer reads of a body into the stage's `let`, beside the `let` that the developer wrote. The `jsmql_` names cannot collide with the developer's names.
- The compiler refuses a `?.` on the stream (`$$?.filter(…)`). The stream is never null, so the `?.` is a wrong reading of `$$`.
- A diagnostic stage is a SOURCE stage, and it has no link form. `streamLink` refuses it by name. Without this check, `$$.$indexStats({})` compiles, and `$$.$currentOp({})` puts a CLUSTER stage on a collection's chain, where the scope gate cannot see it. `refStatement` also refuses the `$`-name of a diagnostic stage on a reference. The row of the sugar states the scope. The `$` row does not. So the `$` spelling would put a cluster stage on a collection with no check.
- The compiler refuses a cell that reads the ELEMENT on a stream of whole documents (`elementOnlyOf`).
- `streamLink` passes `name` (the row that runs) and `link.name` (what the developer typed) to `stageInputs`. A message that swaps them tells the reader about a method that they did not write.
- `peels` says whether a link is a chain link. A `$`-named link is always a link: it is a stage of the developer's own MQL, known or not. A cell that reads the element is not a link on a stream of whole documents, so the join road then reads the joined array as a value.
- `stageStatement` sends a chain rooted in a context reference to the stream road or the join road, before the registry sees its last link. MEASURED: without this check, `$$$.orders.$match({ a: 1 });` emitted `[{ "$match": { "a": 1 } }]`, a filter on the wrong collection. A bare `$$.<name>(…)` with one link asks the STATEMENT cell of the row first. The union sugar (`$$.push(…)`) and the source stages (`$$.indexStats()`) are statements that the source writes on the stream.
- A statement cell that a PASS owns is the FIELD form: the desugar rewrites `$.a.sort("k");`, and a stream receiver never reaches it. Where the row also states a chain rule, the bare `$$.sort("k");` is that chain link, as `$$.toSorted("k");` is. Without a chain rule, the statement road words the refusal.
- An unknown name spelled on `$$$$` or `$$$` is a diagnostic stage that does not exist at that scope (`$$$$.currentOpp();`), not a collection read. The refusal lists the stages of that scope.
- The compiler refuses a raw stage document with more than one key (`{ $match: …, $sort: … }`), and the message asks for one stage per document. MEASURED: the server refuses a stage document that holds more than one field, and `place` needs the one name that each stage document holds.
- A call of a function that the program declared is a value, not a statement. The declared name wins over a global of the same name.
- A mutator needs a receiver that is a field or a binding. Any other receiver has nowhere to write.
- A stage, an operator or a global function takes no receiver. Its statement form is the bare call, and the stage document of `$.items.$sort(…);` has no place for `$.items`.

## Consequences

A new statement form must enter through `stageStatement` and pick its road there. A change to raw-stage handling must keep the one-key refusal. A new diagnostic stage needs only its row; the link refusal and the scope check follow. A message must use the typed name, never the row name.
