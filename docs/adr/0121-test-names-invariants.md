# 0121. The invariants of the variable names that the compiler writes

Status: Accepted
Applies to: `test/compiler-names.test.ts`

## Context

MongoDB variables live in one flat scope. `src/compiler/emit/names.ts` mints every variable name. `test/compiler-names.test.ts` guards each class of bug that a name minter can have.

## Decision

- I1: a mint is never a name that the program uses, wherever in the program the name is bound.
- I2: a read of an unbound name is the developer's error, at its position.
- I3: every written name is one that the server accepts. The test measures the grammar and does not rely on memory. MEASURED on mongod: a variable name starts with a lowercase ASCII letter, then holds only `[A-Za-z0-9_]`.
- I4: two JavaScript names never become one variable.
- I5: the plain case is untouched, so `$$x` reads as the developer wrote `x`.
- For I1, `Scope` mints against every name that the program introduces, not only the names in scope at the site. A parameter of a lambda deeper than the mint site, for example `jsmqlArr`, would otherwise get the same name as the mint. Then the inner body would read the wrong binding.

## Consequences

Update `SERVER_GRAMMAR` after each new measurement. A change to `mongoVarName` or `Scope.bind` must keep all five invariants.
