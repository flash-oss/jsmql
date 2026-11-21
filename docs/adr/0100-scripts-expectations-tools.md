# 0100. How the expectation tools decide what the compiler answers

Status: Accepted
Applies to: `scripts/expectations.mjs`, `scripts/regen-expectations.mjs`

## Context

`scripts/regen-expectations.mjs` and `scripts/convert-expectations.mjs` rewrite the expected values of a test suite with the answers of the compiler. They evaluate each subject in the scope that the suite builds. An evaluation can fail for a reason that has nothing to do with the language. A wrong rewrite then changes a test with no cause.

## Decision

- `compilerThrew` in `scripts/expectations.mjs` reads some errors as a failure of the harness, not as a refusal of the compiler. These errors are a `ReferenceError`, a `SyntaxError`, and a `TypeError` whose message does not start with `jsmql`. The tools leave the expectation of such a call unchanged.
- `literalSubject` marks a subject that is already a literal (a literal expression, `true`, `false`, and similar). Such a subject states its own value, so the compiler has no say in it, and the tools do not rewrite it.
- In `openSuite`, `bind` returns false when a top-level constant needs the module it lives in. That constant stays out of the evaluation scope. A later evaluation that reads it fails with a `ReferenceError`, and `compilerThrew` then leaves the expectation alone.
- `matcherAccepts` in `scripts/regen-expectations.mjs` treats a matcher that it cannot evaluate as a match. The tool keeps that matcher unchanged.
- `toBe` checks identity, and only a primitive keeps its identity across a rebuild. So when the answer is not a primitive, the regen tool rewrites `toBe` to `toEqual` in place.

## Consequences

A tool rewrites an expectation only when the compiler itself gave the answer. A new kind of harness failure must also go through `compilerThrew`, or the tools rewrite a test for the wrong reason. Keep the `toBe` rewrite, or a regenerated object assertion fails on identity.
