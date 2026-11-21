# 0063. Runtime cross-reference checks of the registry rows

Status: Accepted
Applies to: `test/registry-agrees.test.ts`

## Context

Type-level audits in `src/registry/names.ts` and `test/types/registry-contracts.ts` hold a reference from one row to another. Some rules relate the presence of one field to the content of another field, or a vocabulary member to the rows that use it. A type cannot hold these rules, so `test/registry-agrees.test.ts` checks them at run time over the whole table.

## Decision

The test holds these rules:
- A row with `params` takes a callback, so it must state an iteratee layout for each family it names. Without it, the desugar pass cannot tell `$.o.mapValues("name")` (an arrow only) from `$.rows.uniqBy("id")` (a property-path shorthand). Phase 5 then receives a string where an arrow belongs. `arrowOnly` states that nothing stands in for the arrow. An omission and a decision look the same, so the row must state the decision. A family that the row refuses in value position (`refusedFamily`) takes no callback and needs no layout. The row spells `groupBy` on `Object` only so that `Object.groupBy(…)` gets a message that names the receiver form.
- `readsNullAsEmpty` applies only to an array or object row. HR5 runs an array method on `[]` and an object method on `{}`, and the fact says that the operator already gives that answer for null. On a string row it means nothing.
- The registry imports nothing outside itself, so it spells reserved slot names that `src/namespace.ts` also spells. The test asserts `GROUP_SLOT` equals `GROUP_TMP` and the two `LENGTH_SLOT` values are equal. A rename on one side alone gives a stage that writes one field and a read of another.
- Each `Only` member is used by at least one row.
- Each `Only` member qualifies a stage or a link. The placement can belong to an operator that the stage carries. MEASURED: the server allows a `$match` with `$text` only as the first stage, so the rule sits on `$text`. A row that stands in none of those positions has nothing to qualify.
- The document `Type` changes at a stage, and a stage is the row with `bodyPositions`. So `document` and `bodyPositions` come as a pair. On a value row, `document` would make the scope tracker drop bindings after an expression. On a stage row without it, the tracker would have to guess.
- Each name in an update-spec allow list must be a stage of the registry. Otherwise it never matches the stage that `place` asks about, and the allowance never applies.
- `valueTwin` sits on a stage, and names an operator whose row lists `value`. The refusal of `$.items.$match(…)` names that twin.
- `renamedTo` sits only on a row that refuses in every position, and its target lists a position. A typo of the old name gets the new name as its suggestion, so the new name must run.

## Consequences

A new row fact that relates two fields, or a vocabulary member to its rows, gets a check here. Each check must fail once on a bad row before anyone trusts it.
