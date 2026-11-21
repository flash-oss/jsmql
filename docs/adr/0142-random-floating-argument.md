# 0142. lodash's `floating` argument of `.random()`

Status: Rejected
Applies to: the `random` row in `src/registry/names.ts`

## Context

The idea: accept lodash's third `floating` argument, `x.random(y, true)`, which forces a fractional answer.

## Decision

The developer rejected this. `.random()` has one rule for the form of its answer. Two whole bounds give a whole number. Any other pair gives a fractional number. A flag that forces a fractional answer adds a second rule beside the rule of the bounds.

## Consequences

- The compiler refuses a second argument with the argument-count error of the row.
- For a fractional answer, give a bound that is not a whole number.
- Reconsider only if the rule of the bounds cannot express a case that a program needs.
