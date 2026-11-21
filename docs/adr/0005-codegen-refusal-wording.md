# 0005. Which refusal wins, what a refusal may suggest, and which fact it names

Status: Accepted
Applies to: `src/compiler/emit/errors.ts`, `test/codegen.test.ts`

## Context

A JavaScript developer expects a call to mean what it means in JavaScript. A silent drop of an argument is the one error that a user cannot see in the output. `src/compiler/emit/errors.ts` holds every message of the emit phase. Most refusals come from a row. Some shapes depend on what the source wrote, on the position, or on a server rule. A reader of the code cannot see the reason for each choice of which fact the message names.

## Decision

Which refusal wins:
- A higher-order method refuses JavaScript's trailing `thisArg` argument (`.map(fn, thisArg)`), as `.trim("x")` refuses its extra argument. In the `wrongCount` case, the message adds a note about `thisArg`. A bare count does not tell a reader who knows the JavaScript signature why `.map(f, thisArg)` fails. A shape check still wins where it says more than a count. `.reduce` takes two arguments, so this rule does not apply to it.
- A zero-argument date accessor such as `.getFullYear()` refuses an argument. The accessor reads the whole date, so the argument has nowhere to go. The methods that take a timezone, such as `.week("UTC")`, keep it.
- When a row states a refusal for the position, that refusal answers even on a receiver that the row's `on` does not admit. It is the more specific sentence, and the project wrote it for the receiver that reaches it.
- A mutator is the exception. Its refusal is advice about arrays: it names `.toSorted()`, which is wrong for a string. So on a receiver of the wrong family, the family mismatch comes first. On a real array the mutator advice stays. On a field, `jsmql.expr` reads the call as a statement and names `jsmql.pipeline()`. On a computed array, the value road names the immutable twin.
- In the `wrongReceiver` case, a stage in statement position runs on one context reference. When `sel.accepts` names one family, the hint names that reference (`$$.<name>()` or `$$$$.<name>()`), and none of the value hints. The sentence of the row for the family (`siblingOf`) wins over the generic hints that follow it.

What a refusal may suggest:
- A user-facing message never holds a `[DEF-NNN]` tracking id. The id belongs in the source, not in what the developer reads.
- A namespace that lists no position, such as `Math` or `Array`, is never a suggestion for an unknown call, so `Map(…)` is not told to write `Math(…)`. A class that JSMQL refuses, such as `Set`, is never a suggestion either.
- `noReceiver` lets a global that no position takes answer with its own refusal. That refusal names the spelling to write instead, for example `$.x?.toString()` for `$.a.String()`. It never names the refused `String(…)`.

Which fact a message names:
- `RUNS_ON` has two keys for one place. The receiver family of a stage is `stream`. The scope of a diagnostic stage is `collection`. Both name the root stream, so both are keys.
- `NO_CELL` gives the reason of the position, in the words that the rows use. So the compiler refuses a name that a row never mentions in a position like a name whose row refuses it there. The caller passes the name with quotes.
- `refusalFor` takes `spelled`, the name as the source wrote it, for example `'.trim()'`, `'$abs'` or `'Date.now'`. One row answers for every spelling. Only the caller knows which spelling it saw.
- `methodsOf` keeps a renamed row when its new name (`suggestedAs`) runs on the family. A message then spells the method as `spelledMethod` does, for example `.toLower()` for `toLowerCase`.
- `operandAt` indexes the elements of a packed spread. A call with a spread passes its arguments as one packed list, and the proofs hold one entry per element of that list.
- `forbiddenInContainer` is for a stage that the source wrote. `bannedNested` is for a stage that a sugar makes. The source never named that stage, so its message starts with what the source wrote.
- `writeToOwnStream` covers every mutator spelling. `.push`, `.sort` and similar methods desugar to an assignment on the receiver. So the message names the chain links that do the same job.
- `notAStreamLink` spells a diagnostic stage on its own reference, with no body (`$$.indexStats()`). It does not use the `.$name(body)` link form.
- `notAnArrow` relies on an invariant of an earlier pass. That pass rewrites a whole-number index to an arrow. So a number that arrives in an index slot is negative or a fraction.
- `notAStageOnRef` treats an unknown name on `$$$` or `$$$$` as a wrong spelling. Only a diagnostic stage of that scope has a spelling there. On the database, where no stage has one, the message names both scopes.
- `valueInStream` refuses a known name because it makes a value. A name that no row knows makes no value. So it gets the unknown-method refusal, with the nearest link of a chain.
- `rootMustBeDocument` follows a measured server rule. The server refuses `{ $replaceWith: 5 }`, a string, an array and `null`, because none of them is an object. It accepts a field path, because only the run can tell what the path holds. `root` is the document as the source wrote it: `$`, or the own parameter of a body.

## Consequences

A new refusal site must follow these orders and filters. A change to `RUNS_ON` keeps both keys. A change to the desugar pass that stops a rewrite of whole-number indexes, or of mutator spellings, must also change `notAnArrow` and `writeToOwnStream`. A change to `operandAt` must keep the packed-spread indexing.
