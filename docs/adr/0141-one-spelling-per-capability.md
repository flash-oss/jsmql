# 0141. A second spelling for one capability

Status: Rejected
Applies to: the static-call rows (`Object.*`, `Math.*`, `Number`, and similar) in `src/registry/names.ts`, `docs/LANGUAGE.md`

## Context

The idea: accept a JavaScript static beside the method or operator that says the same thing. Examples are `Object.keys(o)` beside `o.keys()`, and `Math.abs(x)` beside `x.abs()`.

## Decision

The developer rejected this. One capability gets one spelling, and the shorter spelling wins. Two spellings of one capability make each codebase pick one, and they give a reader two forms to learn. So a JavaScript static is not a JSMQL name when a method or an operator says the same thing in fewer characters. `Object.groupBy` and `Set` ([ADR 0140](0140-no-set-type.md)) are cases of the same rule.

The compiler refuses a type name as a conversion function for another reason. The conversion method names the MongoDB type that the developer gets.

## Consequences

- Write `o.keys()` for `Object.keys(o)`, and `a ** b` for `Math.pow(a, b)`.
- Write `x.toDouble()` for `Number(x)`.
- The refused name still parses. Its row refuses it and names the one spelling.
- A static stays when it is the shorter spelling, for example `Date.now()`, or when it has no other spelling, for example `Date.UTC(…)`.
- A constant stays a literal: `Long(5)`.
- The rows in `src/registry/names.ts` hold the live list. See [docs/LANGUAGE.md § Object Operations](../LANGUAGE.md#object-operations), [§ Number Methods](../LANGUAGE.md#number-methods) and [§ Type conversion methods](../LANGUAGE.md#type-conversion-methods).
- Reconsider a name only if its static becomes the shorter spelling.
