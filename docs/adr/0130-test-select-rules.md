# 0130. How the selector picks the rule of a row in compiler-select.test.ts

Status: Accepted
Applies to: `test/compiler-select.test.ts`

## Context

`src/compiler/emit/select.ts` picks the rule of a row from the receiver and the shape of the arguments. `test/compiler-select.test.ts` holds static audits over the whole table.

## Decision

- The fold writes a settled constant back as a literal. So `shapeOf` reads an expression that the fold did not settle, for example `1 + 2` at that phase, as `dynamic`, which the server reads at run time.
- A constant that reaches a row did not fold. The `Date` row still has a rule for it, because a live date converts. The rule checks the kind before it refuses the value.
- `byArgs` names `none`, `multiple`, `constant` and `dynamic`. An object literal belongs to none of them, so the `otherwise` of the row answers.
- `ceil` is on number and on `Math`. A receiver of unprovable family is a number by the claim of the row. The `Math` cell refuses the static, because the own method of the receiver is the one spelling.
- A family that the row refuses does not count as a lowering family. For example, `.keys()` lists array and object, refuses array, and runs on object. The audit asserts that a row lowers on one family at most, so a receiver of unprovable family selects that family. The audit asserts a floor on the rows that it read.

## Consequences

A new `perFamily` row must lower on one family at most. Make sure that the floor matches the registry.
