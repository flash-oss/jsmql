# 0119. The fold-consistency suite compares each constant fold with the server lowering

Status: Accepted
Applies to: `test/fold-consistency.test.ts`

## Context

A foldable method has two readings of one meaning. The constant engine (`src/compiler/passes/evaluate.ts`) computes the value at compile time. The MQL lowering computes the value on the server for a receiver that is known only at run time. When the two readings disagree, a fold emits a value that the server never gives. HR3 forbids this result.

## Decision

`test/fold-consistency.test.ts` runs each foldable method over a set of sample receivers and compares the two readings.
- Each case holds a receiver literal as JSMQL source, the same value as a seed field, and a call suffix. The fold side compiles `const __k = <lit><call>; $project({ v: __k })`. The server side runs `jsmql.expr("$.s<call>")` over `{ s: <val> }` through `$documents` and `$addFields`, so the suite writes no collection. The receiver comes from the document, so the server side never folds.
- `foldedValue` reads a fold as exactly one `$project` stage. A runtime binding gives a leading `$set` on `__jsmql.var.__k` and a trailing `$unset`, and the helper returns `NOT_FOLDED`.
- A non-fold is a safe outcome, because the server runs its own lowering. So a case asserts only on a fold, where a disagreement is a real defect.
- A `CodegenError` (an HR7 refusal) has no value to compare, so it counts as `NOT_FOLDED`.
- A negative number literal sits in parentheses, so it binds before the method call by JavaScript precedence.
- HR7 applies to the string samples: a row that takes numbers refuses an array of strings, and a comparison takes operands of one kind. So `NUMBERS_ONLY` skips the number-only calls for strings, and `FOR_STRINGS` rewrites each predicate to compare with a string.
- `$concatArrays` takes arrays only, so `.flat()` runs only on receivers whose elements are arrays.
- The date samples cover calendar edge cases: January 31st of a leap year, a Wednesday, a Sunday at midnight, and a date in ISO week 53.
- A predicate whose value is `""` or `0` runs on every predicate method. MQL truthiness and JavaScript truthiness disagree on these values, so the fold and the lowering must be checked against each other.
- A fold of a document whose keys read as array indexes is an `$arrayToObject` call over pairs (`isOrderedFold`). The driver reads a document into a JavaScript object and loses the key order. So both sides give their pairs through `$objectToArray`, and the suite compares the pairs.
- A set answer is valid in each order. So the suite compares a set answer as a multiset: the same values, each value the same number of times.

## Consequences

A new foldable method must get cases in this suite. Do not emit a new fold that the server cannot match. It stays a runtime binding. A server refusal of an emitted document is never a quiet skip. The suite lists each refusal in `SERVER_REFUSES` with a reason, and an unlisted refusal fails the suite.
