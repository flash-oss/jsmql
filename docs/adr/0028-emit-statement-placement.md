# 0028. The statement target judges the place of every name that a stage document holds

Status: Accepted
Applies to: `src/compiler/emit/statement.ts`, `src/compiler/emit/union.ts`, `test/pipeline.test.ts`, `test/union.test.ts`

## Context

The server enforces placement rules for stages. Some of these rules belong to an operator inside a stage body, not to the stage itself. The server also refuses a read of a scratch field after the cleanup, and a `$documents` stage inside some containers. The compiler must refuse each case before the server does (HR3). The table of the facts that a row states is in docs/specs/emit-pass.md § The statement target.

## Decision

- `place` in `src/compiler/emit/statement.ts` judges every registry name that is a key in the emitted stage document (`namesWithin`). It does not judge only the name of the stage. For example, `$text` may appear only in the first `$match` of a pipeline, at any depth of its body.
- For a name that the BODY holds, the stage that carries the name is also a container. So is each sub-pipeline boundary that the compiler crossed. MEASURED: `$where` runs in a `find` filter, but the server refuses it in an aggregation `$match` at any depth of the body. The rows state this as a fact about the pair (`forbiddenIn` on the name, `bansNested` on the container), and about nothing else.
- A stage's own body sub-pipeline runs under its OWN chain. Without that chain, a stage filed as LAST files onto the outer chain and silently leaves the body. MEASURED: a `$out` inside a `$lookup` body landed at the end of the outer pipeline, and the body came out empty.
- The row states which slots start a pipeline (`statementBody`). The kind of the slot (`statement`) does not say it. `$lookup.pipeline` and a `$facet` branch start a pipeline, but `$merge.whenMatched` is an update spec with no first position and a closed set of stages. A check of the slot kind alone does two wrong things at once. It refuses `$geoNear` first in a `$lookup` body when a statement precedes the `$lookup`, and the server runs that. It also catches a banned stage in `whenMatched` only when a statement precedes the `$merge`, and the server never runs that.
- `readsScratch` treats a string as a read of a scratch field only when the string starts with `$` and the `__jsmql` namespace. A read is a field path, so it carries the leading `$`. This keeps a collection name such as `__jsmqlArchive` legal, because `$out` takes the name as written: `$$$["__jsmqlArchive"] = $$` compiles. A `$merge` `let` that reads a real field of the document stays as written.
- `arrayReduceStages` calls `place` in its own statement, before `env.chain.ahead()` drains the hoist. `place` reads the hoist that is still pending on the chain. An argument list evaluates `ahead()` first, and then `place` gets an empty hoist.
- `unionStages` in `src/compiler/emit/union.ts` checks each boundary row for a `bansNested` entry for `$documents`. The `$unionWith` wrapper makes `$documents` legal inside a `$lookup` and inside another `$unionWith`. MEASURED: the server refuses `$documents` inside a `$unionWith` inside a `$facet`, at any depth. A branch that appends a collection runs. So the compiler refuses `.push(<document>)` inside a `$facet` branch, at any depth. The message names the collection append (`$$.push(...$$$.<coll>)`) and an append outside the branch. A `$facet` branch has no statement position, so the message does not offer the statement form there.
- A written list of documents lowers inside the `$unionWith` body, for `$$.push({ … })` and `$$ = [{ … }]` alike. Outside that boundary, a read of the document in the list becomes a field path, and the server answers `{}` for it with no error.

## Consequences

A placement rule of an operator goes on the operator's row, never into `place`. A new container states its transitive bans in `bansNested`, and a new slot that starts a pipeline states it in `statementBody`. A change to the order of `place` and the drain must keep `place` first. A scratch-field test must keep the leading `$`, or a collection name with the namespace prefix becomes a false refusal.
