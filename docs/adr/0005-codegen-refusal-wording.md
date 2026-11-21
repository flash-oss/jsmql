# 0005. Rules for which refusal wins and what a refusal may suggest

Status: Accepted
Applies to: `test/codegen.test.ts`

## Context

A JavaScript developer expects a call to mean what it means in JavaScript. A silent drop of an argument is the one error that a user cannot see in the output. A suggestion that names a method that also refuses sends the user to a second error.

## Decision

- A higher-order method refuses JavaScript's trailing `thisArg` argument (`.map(fn, thisArg)`), as `.trim("x")` refuses its extra argument. The message names what the argument is for, because a count alone does not help a reader who knows the JavaScript signature. A shape check still wins where it says more than a count. `.reduce` takes two arguments, so this rule does not apply to it.
- A zero-argument date accessor such as `.getFullYear()` refuses an argument. The accessor reads the whole date, so the argument has nowhere to go. The methods that take a timezone, such as `.week("UTC")`, keep it.
- On a receiver of the wrong family, the family mismatch comes before the mutator advice. The mutator advice names `.toSorted()`, which is wrong for a string. On a real array the mutator advice stays. On a field, `jsmql.expr` reads the call as a statement and names `jsmql.pipeline()`. On a computed array, the value road names the immutable twin.
- A user-facing message never holds a `[DEF-NNN]` tracking id. The id belongs in the source, not in what the developer reads.
- `didYouMean` never suggests a method that refuses in every position, for example `.forEach()`. A typo of it gets no suggestion.
- A namespace that lists no position, such as `Math` or `Array`, is never a suggestion for an unknown call, so `Map(…)` is not told to write `Math(…)`. A class that JSMQL refuses, such as `Set`, is never a suggestion either.

## Consequences

A new refusal site must follow these orders and filters. A new candidate set for `didYouMean` must leave out names that refuse everywhere.
