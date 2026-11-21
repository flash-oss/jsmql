# 0141. The stage-validation suite pins deliberately invalid pass-through shapes

Status: Accepted
Applies to: `test/stage-validation.test.ts`

## Context

A stage that the developer spells (`$limit(…)`, a raw stage document, a `$$.$sort(…)` link) is their own MQL. HR3 does not apply, and the compiler passes the body through. `test/stage-validation.test.ts` pins this pass-through with shapes that the server refuses. test/CLAUDE.md asks that each such shape carry the reason for the refusal.

## Decision

The suite records these server facts, measured on `mongod`:
- `$limit` refuses a value that is not a positive number, and it refuses a field path, because it takes a number. `$skip` has the same rule.
- `$count` refuses an empty name, a name that starts with `$`, and a dotted name.
- `$group` refuses a body that is not an object, and a body with no `_id`. `$addFields` refuses a body that is not an object.
- `$sort` refuses a direction other than 1 or -1, and it refuses a sort with 33 keys.
- `$project` refuses an exclusion inside an inclusion projection.
- `$unwind` refuses a path with no `$` prefix.
- A stage name in a value slot passes through, and the server refuses it as an unknown expression operator.

Two cases are not pass-through. A JavaScript spread inside a stage call is JSMQL code. It lowers to `$mergeObjects`, which no stage takes as its body, so the compiler refuses it (HR3). `$count` is both a stage and an accumulator, so `$count()` in a `$group` value slot is valid and lowers to `{ $count: {} }`.

## Consequences

Keep these shapes out of any live "ran each one" list. When the compiler starts to check one of these bodies, move the case to the refusal tests.
