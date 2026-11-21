# 0172. Small decisions about the stream methods

Status: Accepted
Applies to: the `stream` cells in `src/registry/names.ts`, `src/compiler/emit/statement.ts`, `test/stream-methods.test.ts`

## Context

A stream method on `$$` or `$$$.<coll>` lowers to stages. Some JavaScript array methods do not fit that model, and the stream gives some statements a new meaning.

## Decision

- **`.reduce` has no stream cell.** In JavaScript, `.reduce` returns one value, a scalar, an object or an array, as the reducer decides. So the compiler refuses it as a chain method, and the refusal names the wrap forms. A scalar or object reducer wraps into a stream-shaped right side. An array reducer is already a stream, so the code assigns it directly.
- **`.flatMap` takes a field path only.** `$unwind` returns each element to a NAMED field, so the field name is part of what the user means. A computed path in a scratch slot, cleared after, would silently decide the shape of every later document. This is a limit of the meaning, not of the mechanism.
- **A bare `$$.<chain>;` statement transforms the running stream.** In JavaScript, `arr.filter(...)` as a statement discards its result. The bare form is valid JavaScript syntax with a different runtime meaning, which JSMQL allows. It also agrees with the `$$.push(...)` statement sugar.
- **Each method on an array receiver states an answer for the stream.** The answer is a lowering, a value terminal or a written reason. The reason matters more than the refusal. A generic list of the stream methods tells the developer what else exists, but never why THIS one is absent. A reason that the project cannot write well shows a gap. (delete the sentence)

## Consequences

A new array method needs a stream answer, and `test/stream-methods.test.ts` fails without it.
