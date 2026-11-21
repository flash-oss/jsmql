# 0129. How compiler-returns-agrees.test.ts measures every returns fact on mongod

Status: Accepted
Applies to: `test/compiler-returns-agrees.test.ts`

## Context

The `returns` field of a row holds measured data. Only a new measurement finds a stale value. A `toEqual` cannot, and the vendored spec cannot. For example, the vendored `type:` of `$trunc` says `resolvesToString`, but the other sources disagree. This is why `MongoSpec.returns` in `src/registry/names.ts` writes the process down.

## Decision

- The suite builds each call from the vendored `arguments[].type` and the `shape` of the row. A new operator gets coverage when its row exists. Only the calls that a generator cannot express are in `BY_HAND`. Those operators have constraints beyond their declared type. For example, they need an enum, a JSON string input, a domain of [-1, 1] or a window with bounds. Each measurement used the call that its entry holds.
- The suite measures an operator production through its own lowering. The compiler writes the lexeme between two operands of each kind. An operand is a field of unprovable kind, or a literal that is not a string. So `+` takes the `$add` road that its row states. A pair that the compiler or the server refuses proves nothing. A stated kind that no pair gives is a claim with no measurement. The loop asserts a floor on the measured productions.
- `CANNOT_MEASURE` names the operators that the server cannot answer, with a reason. It is not a filter. The last test sends each one its `PROBE` call, and fails when the server answers. So a stale entry shows at once, and the developer must then measure its row. An operator that the first test cannot measure, and that the table does not name, fails the first test.
- Anything that the suite cannot measure must be a named environment limit, never a surprise. The suite asserts a floor on the measured rows. The floor matches what a mongod at the fixture's FCV can measure, so a real loss cannot pass as a version difference.
- `"unknown"` is a measured fact. Each row that claims it owes a pair in `VARIES_BY_OPERAND` that shows the kind varies, or a named reason in `CANNOT_MEASURE`.
- The variance check starts from the pairs, not from the rows. A row that claims to be invariant is the more dangerous error, because the type check then rejects valid code. So each pair decides what its row must say. An operand that the server refuses proves that the type is constrained, and says nothing about variance, so every pair must reach the server.
- The fixture holds two documents with distinct sort keys. A window function refuses a repeated `sortBy` value, and a sample of one makes `$stdDevSamp` null.
- `.size()` of an array literal folds to the element count, with no `$size` at run time. That fold is safe only if the server counts the same way, a missing field and a null included. The test holds each count against the server.
- The presence proof leaves out an `$ifNull` because of the `always` fact. So the test measures `always` with every field operand read as a missing field.

## Consequences

A new operator row needs a measured `returns`, or a `CANNOT_MEASURE` entry with a `PROBE`. Raise the floors when the fixture server gets newer; never lower them to make a failure pass.
