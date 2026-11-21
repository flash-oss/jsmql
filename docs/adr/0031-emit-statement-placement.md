# 0031. The statement target judges the place of every name that a stage document holds

Status: Accepted
Applies to: `src/compiler/emit/statement.ts`, `src/compiler/emit/union.ts`

## Context

The server enforces placement rules for stages. Some of these rules belong to an operator inside a stage body, not to the stage itself. The server also refuses a read of a scratch field after the cleanup, and a `$documents` stage inside some containers. The compiler must refuse each case before the server does (HR3).

## Decision

- `place` in `src/compiler/emit/statement.ts` judges every registry name that appears as a key in the emitted stage document (`namesWithin`), not only the name of the stage. For example, `$text` may appear only in the first `$match` of a pipeline, at any depth of its body.
- For a name that the BODY holds, the stage that carries the name is also a container, beside each sub-pipeline boundary that the compiler crossed. MEASURED: `$where` runs in a `find` filter, but the server refuses it in an aggregation `$match` at any depth of the body. The rows state this as a fact about the pair (`forbiddenIn` on the name, `bansNested` on the container), and about nothing else.
- `readsScratch` treats a string as a read of a scratch field only when the string starts with `$` and the `__jsmql` namespace. A read is a field path, so it carries the leading `$`. This keeps a collection name such as `__jsmqlArchive` legal, because `$out` takes the name as written.
- `arrayReduceStages` calls `place` in its own statement, before `env.chain.ahead()` drains the hoist. `place` reads the hoist that is still pending on the chain. An argument list evaluates `ahead()` first, and then `place` gets an empty hoist.
- `unionStages` in `src/compiler/emit/union.ts` checks each boundary row for a `bansNested` entry for `$documents`. The `$unionWith` wrapper makes `$documents` legal inside a `$lookup` and inside another `$unionWith`. The wrapper does not make it legal inside a `$facet`.

## Consequences

A placement rule of an operator goes on the operator's row, never into `place`. A new container states its transitive bans in `bansNested`. A change to the order of `place` and the drain must keep `place` first. A scratch-field test must keep the leading `$`, or a collection name with the namespace prefix becomes a false refusal.
