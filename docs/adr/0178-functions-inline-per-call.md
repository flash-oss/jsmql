# 0178. A reusable function is a named IIFE that each call inlines

Status: Accepted
Applies to: `applyLambda` in `src/compiler/emit/lower.ts`, `declarator()` in `src/compiler/parse/parser.ts`, docs/specs/reusable-functions.md

## Context

`const f = (x) => …` can lower once at the declaration, or at each call. A `const` can also hold a value, so the parser must tell a function from a value.

## Decision

- A call of a reusable function is sugar for `((params) => body)(args)`. So the feature reuses the IIFE lowering to `$let`, and adds only the name of a lambda and the resolution of a call.
- Each call site lowers the body on its own. The compiler hoists nothing and shares no common expression. So the same input always gives the same output, and the shape of the output never depends on the data.
- The initialiser alone decides between a function and a value: an arrow is a function, and anything else is a value. The fork is syntactic, with no data dependence and no heuristic. So a JavaScript developer reads "a `const` that holds a function" against "a `const` that holds a value", as in JavaScript.

## Consequences

Two calls give two `$let` blocks. An uncalled declaration leaves no trace in the output.
