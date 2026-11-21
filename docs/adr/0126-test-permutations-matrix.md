# 0126. The permutation suite compiles and runs every ordered pair of chain methods

Status: Accepted
Applies to: `test/permutations.test.ts`

## Context

A chain of methods is a combinatorial surface. No hand-written case covers every "method X fails after method Y" pair. Some failures appear only on the server: a `$slice` with a count of zero, for example, which the server refuses.

## Decision

`test/permutations.test.ts` builds every ordered pair of methods from lists grouped by input and output shape: reshaper by reshaper, and reshaper by terminal, for value mode and for stream mode. Each chain must compile. When the `:27018` instance is up, each emitted document must also run on it without a server error. The server half follows [ADR 0188](0188-live-suite-skip-rule.md): no environment variable gates it.
List rules:
- `countBy` and `groupBy` are not stream reshapers. They collapse the stream to one object, so they sit with the terminals. A reshaper that removes fields before them gives `$arrayToObject` a null key, which the server refuses.
- `STREAM_LOOKUP_RESHAPERS` keep the document, so the value terminals after them still see `total` and `userId`. The reshapers that rebuild the document (`map`, `pick`, `omit`, `flatMap`) appear only in the reshaper-by-reshaper matrix. A pair of such a reshaper with a terminal that reads a field has no meaning.
- `STREAM_TERMINALS` holds no numeric terminal such as `.sum()`, because the elements of a stream are documents (HR7). `.sumBy()` and `.meanBy()` read a number from each document.
- `STREAM_READS` states, by hand, the fields each stream reshaper reads and, for a closed document, the fields it keeps. A chain whose second link reads a field that the first link did not keep has no value. The compiler must refuse it, and such a chain carries `refused: true`. A person writes this table, so the refused pairs never come from the compiler under test. `pick` and `omit` read no field that must be present.
- The seed documents vary the array size, with a single-element row and an empty row. These rows expose the zero-count `$slice` edge of `drop`, `tail` and `takeWhile`.
After a run, no returned document may hold a field under `__jsmql`. That namespace is the compiler's scratch space, never the developer's data.

## Consequences

A new chain method goes into the list that matches its input and output shape, and a new stream reshaper needs a `STREAM_READS` row. Keep the empty and single-element seed rows.
