# 0042. The interpreter runs only the regex syntax that PCRE2 and JavaScript share, printed as a new JavaScript pattern

Status: Accepted
Applies to: `src/compiler/interpret/regex.ts`

## Context

The server runs PCRE2 for `$regexMatch`, `$regexFind` and `$regexFindAll`. The interpreter runs the JavaScript engine. The two engines agree on a small syntax only. A backtracking engine also has no bound on its time. src/compiler/interpret/CLAUDE.md lists the shared syntax and the measured differences. This record holds the design of `src/compiler/interpret/regex.ts` that the CLAUDE.md does not state.

## Decision

- `regex.ts` reads the pattern into a tree (`Node`), and refuses each construct outside the shared syntax. The tree then prints as a new JavaScript pattern (`print`). So no character of the source reaches the JavaScript engine as syntax that the reader did not read. `lit` prints every character other than a letter, a digit or a space as a hex escape for the same reason.
- A shorthand class (`\d`, `\w`, `\s`) stands alone in a class. A range cannot start or end on it.
- A hyphen in a class is a literal only at the start or at the end of the class.
- A lazy suffix, a possessive suffix and a second quantifier mean other things in PCRE2. The reader refuses each of them after a quantifier.
- A quantified group may hold no capture, no second quantifier and no alternation. Its body may not match the empty string. A capture differs between the engines, and an alternation or a nested quantifier gives a runaway backtrack. `inspect` reads these facts.
- After the parse, the reader must stand at the end of the pattern. A `)` with no `(` ends the sequence early, and this check refuses it.
- The cost bound: `degree` counts how many unbounded repeats the pattern can nest or chain. The cost of a run is the subject length to the power of the degree plus one. `compile` sets the longest subject as the root of `MAX_COST` of that power, capped at `MAX_SUBJECT`. A longer subject is a refusal. `MAX_PATTERN`, `MAX_DEPTH` and `MAX_COUNT` also cap the form of the pattern.
- `insidePair`: a JavaScript engine can report an empty match between the two halves of a surrogate pair, for a pattern such as `(?![^a])`. The server never does. So such a match is a refusal.
- `regexRule` reads the shared operand `input`, `regex` and `options`. It compiles the pattern before it reads the subject, so a pattern outside the syntax always refuses, also for a null `input`. A null `input` gives the empty answer of the operator. An answer of `undefined` from an operator is a refusal.

## Consequences

A new construct enters the syntax only after a measurement shows that both engines give the same answer. The printer must stay the only path from the source to `new RegExp`. A change to the cost model must keep a bound on the run time for every pattern that the reader accepts.
