# 0033. How the statement target lowers a write, a stream assignment and a root replacement

Status: Accepted
Applies to: `src/compiler/emit/statement.ts`

## Context

A write statement can target a field, a binding, the document root, the stream or a collection. Each target has its own lowering road in `writeStages`, `becomeStream` and the helpers around them in `src/compiler/emit/statement.ts`. The server refuses some shapes, and some refusals must name the spelling that the developer wrote. The specs give the main rules (emit-pass.md § The statement target, replace-root-stage.md § Fan-out belongs to the stream, not the root). This record keeps the smaller decisions that no spec states.

## Decision

- `clearOfNamespace` puts `{ $unset: "__jsmql" }` ahead of the statement. The statement's own writes come after that `$unset`. So when the statement made no write under the namespace (`chain.writes` did not change), the chain is clean again, and the code sets `chain.dirty` to false.
- `declStages` lowers each declarator after the first one speculatively. A declarator that hoists a prologue goes back (`mark` and `rewind`), and the compiler lowers it again as its own statement. The check reads both `env.chain` and `env.rootChain`, because `$$.size()` materialises on the ROOT chain.
- `targetPath` refuses a write to `$` inside a body over another collection. The outer document is out of reach there. The body's own document is its parameter, so `o.x = …` writes that document.
- A callback's stream parameter is bound, but not as a value. A mutator on it, for example `c.push({ … });`, desugars to `c = [...c, { … }]`. So every spelling of a write to a stream arrives at `targetPath` as one assignment, and one refusal covers all of them.
- `rootAsWritten` gives the root as the developer wrote it: the bare `$`, or a body's own parameter (`o` in `.aggregate(o => { … })`). A refusal of a root write quotes this spelling, so the fix that it names works where the write stands.
- `becomeStream` is the one road from a value to the stream. `$$ = <value>;` and each write of a value into a collection use it, so the two spellings emit the same stages by construction. A chain on `$$`, on the callback's own stream, or on another collection takes the stream road, whatever kind its last link returns. `valueEnv` is the Env for the value, and it differs by spelling. The position pass marks the `$$ =` edge as STREAM, because a chain is the usual spelling there. The compiler must still read an array as a value.
- `becomeStream` refuses a value that is not a chain but that the registry proves a stream, for example `c ? $$.filter(p) : $$.filter(q)`. The refusal names the forms that a stream takes.
- `facetStages` records the branch names in a `Set`. The `in` operator answers true for every name on `Object.prototype`, so a branch called `toString` would read as a duplicate.
- `facetStages` refuses two branches under one name. JavaScript keeps the last of two equal keys, but here the first branch would vanish with no error.
- The `flush` in `writeStages` still emits a group after the Env holds each write's proof. An `$unset` changes the fields that a stamped count can name.
- The compiler refuses a root replacement with `null` or `undefined`. The registry cannot prove `null` as a kind, and the server refuses it there.
- The compiler refuses a root replacement with a value that is only an array. The message names `$$ =`, because `$` is one document and `$$` is the stream. The compiler refuses a value that can NEVER be a document. A value that MAY be a document passes, and the server judges it.
- `refuseUnbuiltSugar` refuses a write whose value reads a collection or the stream in a place that has no join, `$facet` or `$unionWith` lowering. Without this guard, the value road refuses the scope, and that message is true of an expression but wrong for the statement. `$$.size()` passes, because its row states a stream cell in the value position. A chain on the stream is documents, not a value.

## Consequences

A new write target must enter through `targetPath` and `writeStages`, so that the grouping and the proofs stay correct. A new spelling of a stream write must desugar to the one assignment. A refusal of a root write must quote `rootAsWritten`. A change to the speculative lowering must keep the check on both chains.
