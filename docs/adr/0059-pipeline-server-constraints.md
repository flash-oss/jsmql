# 0059. Raw stage documents hold one key, and the scratch guard reads paths

Status: Accepted
Applies to: `test/pipeline.test.ts`

## Context

A raw stage document can carry more than one key. A terminal stage body can read a value that the compiler parked in the `__jsmql` scratch namespace, and the cleanup of that namespace runs before the terminal stage.

## Decision

MEASURED: the server refuses a stage document that holds more than one field. The compiler refuses such a raw stage at compile time and asks for one stage per document.
The guard refuses a terminal-stage body that reads a scratch field. It matches a field PATH (a read that carries `$` and the namespace), not the name of the namespace. A collection called `__jsmqlArchive` is a name that `$out` takes as written, so `$$$["__jsmqlArchive"] = $$` compiles. A `$merge` `let` that reads a real field of the document stays as written.

## Consequences

A change to the scratch guard must keep collection names out of its match. A change to raw-stage handling must keep the one-key refusal.
