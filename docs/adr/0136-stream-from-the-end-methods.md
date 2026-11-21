# 0136. "From the end" array methods on a document stream

Status: Rejected
Applies to: the `takeRight`, `dropRight`, `initial` and `toReversed` rows in `src/registry/names.ts`, `docs/specs/stream-methods.md`

## Context

The idea: accept `.takeRight`, `.dropRight`, `.initial` and `.toReversed` on a document stream (`$$.<method>(…)`), in addition to an array value.

`.takeRight(n)`, `.dropRight(n)`, `.initial()` and `.toReversed()` work on an array value. The idea is to give them a stream form on `$$` and `$$$.<coll>`.

## Decision

The developer rejected this. MongoDB has no stage that reverses a stream. `$reverseArray` is an expression for an array inside a document, not for a stream. A stream has no order except the order that a `$sort` gives it, so "the last n" has nothing to count back from.

The only possible design is also the argument against the feature. All four methods must reach back and rewrite the preceding `$sort`. That rewrite has three defects:

- It makes the method position-dependent, and the JavaScript method of the same name never is. `.takeRight(3)` would mean a different thing for each stage before it.
- It silently orders by `_id` when no `$sort` comes before it, and it raises no error. This gives a wrong answer with no diagnostic. `$$.shuffle().takeRight(3)` would return the last 3 documents by `_id` and discard the shuffle.
- It makes `.toSorted(c).toReversed()` a second, longer spelling for a descending comparator. This is the "which spelling does my codebase use?" problem that [ADR 0141](0141-one-spelling-per-capability.md) rejects.

The rejection is for the stream receiver only. In value position the family stays: `$.items.takeRight(3)` becomes `$slice`, and `$.items.toReversed()` becomes `$reverseArray`. A stored array has its own order, so there each method means exactly what it means in JavaScript. The receiver makes the difference, not the method.

The developer rejected the idea. MongoDB has no stage that reverses a stream (`$reverseArray` is an expression, for an array in a document). A stream has no order except the one a `$sort` gives it, so "the last n" has nothing to count back from. The only way to fake these methods is to rewrite the `$sort` before them. That makes them depend on their position in a way that the JavaScript methods do not. With no `$sort` in front, they silently order by `_id` and raise no error. `.toSorted(c).toReversed()` is also a longer spelling of a descending comparator.

The same reason sets the rule for a cell that reads the chain before it. Read the earlier stage and never rewrite it. Refuse when the earlier stage is absent and never guess it. `.takeWhile` and `.dropWhile` follow this rule.

## Consequences

- On a stream, state the order and take from the front: `$$.toSorted({ createdAt: -1 }).take(3)`.
- The stream refusal of each row in `src/registry/names.ts` names this rewrite. The refusal reaches every chain-assembly site, and a foreign chain too. So a developer cannot fall back quietly to value mode and slice the tail of an array whose order came from the foreign scan.
- Reconsider only if MongoDB adds a stage that reverses a stream. A new implementation over the `$sort` machinery would have the same two defects.

Each of the four rows states an `unsupported` stream cell, which names the rewrite that takes from the front. The four methods keep their value form on a real array.
