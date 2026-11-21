# 0021. Calls, logical values and blocks in lower.ts

Status: Accepted
Applies to: `src/compiler/emit/lower.ts`

## Context

`dispatchOn`, `newExpression`, `booleanOf`, `logicalValue` and `exprBlock` in `src/compiler/emit/lower.ts` each make a choice that the registry rows cannot state.

## Decision

- `receiverOf` hands a regex receiver over as the source node, not as a lowered value. A regex has no value of its own, and its row reads the pattern and the flags off the node.
- The HR5 empty-value wrap in `dispatchOn` applies only where the receiver is a VALUE of the document (position `value` or `filter`). Inside `$group` or a window, the receiver is the per-document operand of the accumulator. `$sum: "$a"` reads the `a` of each document as it is, so no wrap goes there.
- `passes/no-new.ts` refuses most `new X(…)` forms (HR8). `newExpression` handles the cases that remain. One case is a name that the program binds, which needs the scope. The other is a row that every position refuses, and its own refusal names the fix.
- `booleanOf` turns a truth into a boolean value. A condition reads a number, and a boolean that may be missing, as its own truth. So such a truth takes `{ $cond: [t, true, false] }`. A constant folds. A boolean that is present is its own value. So is the answer of an operator whose row states `returns: "bool"` and `neverNull: "always"`, for example `$gt` and `$and`.
- `logicalValue` binds a computed left side of `&&` or `||` once, with `$let`. A path or a boolean is cheap to read twice, once in the test and once as the operand, so it takes no `$let`.
- `exprBlock` lowers each declarator ONCE. A declarator that breaks its `$let` group is already lowered, so it goes to the next `$let` as a carried value. A second `lowerValue` call would mint a second compiler name for the same value.

## Consequences

- A new position that reads an accumulator operand must not take the HR5 wrap.
- A change to `exprBlock` must keep the carried value, or the output gets two names for one value.
