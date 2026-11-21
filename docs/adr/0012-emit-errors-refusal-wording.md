# 0012. How the emit phase words a refusal that a row does not carry

Status: Accepted
Applies to: `src/compiler/emit/errors.ts`

## Context

`src/compiler/emit/errors.ts` holds every message of the emit phase. Most refusals come from a row. Some shapes depend on what the source wrote, on the position, or on a server rule. These shapes need small decisions about which fact the message names. A reader of the code cannot see the reason for each decision.

## Decision

The module applies these rules:
- `RUNS_ON` has two keys for one place. The receiver family of a stage is `stream`. The scope of a diagnostic stage is `collection`. Both name the root stream, so both are keys.
- `NO_CELL` gives the reason of the position, in the words that the rows use. So the compiler refuses a name that a row never mentions in a position like a name whose row refuses it there. The caller passes the name with quotes.
- `refusalFor` takes `spelled`, the name as the source wrote it, for example `'.trim()'`, `'$abs'` or `'Date.now'`. One row answers for every spelling. Only the caller knows which spelling it saw.
- In the `wrongReceiver` case, a stage in statement position runs on one context reference. When `sel.accepts` names one family, the hint names that reference (`$$.<name>()` or `$$$$.<name>()`), and none of the value hints.
- In the same case, the sentence of the row for the family (`siblingOf`) wins over the generic hints that follow it.
- In the `wrongCount` case, a callback method with one argument more than its maximum gets a note about JavaScript's trailing `thisArg`. A bare count does not tell the developer why `.map(f, thisArg)` fails.
- `methodsOf` keeps a renamed row when its new name (`suggestedAs`) runs on the family. A message then spells the method as `spelledMethod` does, for example `.toLower()` for `toLowerCase`.
- `operandAt` indexes the elements of a packed spread. A call with a spread passes its arguments as one packed list, and the proofs hold one entry per element of that list.
- `noReceiver` lets a global that no position takes answer with its own refusal. That refusal names the spelling to write instead, for example `$.x?.toString()` for `$.a.String()`. It never names the refused `String(…)`.
- `forbiddenInContainer` is for a stage that the source wrote. `bannedNested` is for a stage that a sugar makes. The source never named that stage, so its message starts with what the source wrote.
- `writeToOwnStream` covers every mutator spelling. `.push`, `.sort` and similar methods desugar to an assignment on the receiver. So the message names the chain links that do the same job.
- `notAStreamLink` spells a diagnostic stage on its own reference, with no body (`$$.indexStats()`). It does not use the `.$name(body)` link form.
- `notAnArrow` relies on an invariant of an earlier pass. That pass rewrites a whole-number index to an arrow. So a number that arrives in an index slot is negative or a fraction.
- `notAStageOnRef` treats an unknown name on `$$$` or `$$$$` as a wrong spelling. Only a diagnostic stage of that scope has a spelling there. On the database, where no stage has one, the message names both scopes.
- `valueInStream` refuses a known name because it makes a value. A name that no row knows makes no value. So it gets the unknown-method refusal, with the nearest link of a chain.
- `rootMustBeDocument` follows a measured server rule. The server refuses `{ $replaceWith: 5 }`, a string, an array and `null`, because none of them is an object. It accepts a field path, because only the run can tell what the path holds. `root` is the document as the source wrote it: `$`, or the own parameter of a body.

## Consequences

A new refusal shape keeps these rules. A change to `RUNS_ON` keeps both keys. A change to the desugar pass that stops a rewrite of whole-number indexes, or of mutator spellings, must also change `notAnArrow` and `writeToOwnStream`. A change to `operandAt` must keep the packed-spread indexing.
