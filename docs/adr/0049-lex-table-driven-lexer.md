# 0049. The lexer reads its punctuators and keywords from registry rows, and scanners decide where a token ends

Status: Accepted
Applies to: `src/compiler/lex/lexer.ts`, `src/compiler/lex/scanners.ts`

## Context

`src/compiler/lex/lexer.ts` reads `TOKENS` (src/registry/tokens.ts) and `KEYWORDS` (src/registry/keywords.ts). A longest-match table cannot state every lexical decision. Some decisions also need an algorithm, not a table. src/compiler/CLAUDE.md names the row-stated rules, and docs/specs/state-machines.md § The lexer covers the depth and `/` transitions. This record holds the rest.

## Decision

- The punctuator order comes from the key length, longest first (`PUNCTUATORS`). So `===` cannot be shadowed by `==`, and no row needs a hand-placed position.
- A row that names two token types must state `chooseBy`. `PUNCTUATORS` checks this at load time, not on the first source text that holds the spelling. The backtick is the one exception: its own position decides its type, and the template branch scans it. Because of the load-time check, a hit with no single type cannot reach the main loop. The loop still throws there as a guard.
- `OTHERWISE_SCANNERS` maps each `chooseBy.otherwise` type to its scanner. So a third spelling that the preceding token classifies can state its own scanner, and the lexer does not treat it as a regex by default.
- `maxRun`: the row key is the longest legal run of one character, so `$$$$` gives the character and the limit together (`MAX_RUN`). The lexer checks the run BEFORE the longest match. Longest match alone splits `$$$$$` into two legal tokens, and the run must fail instead.
- `introducesName`: after `.`, `?.`, `$.` and `$`, a reserved word is a plain name.
- The scanners in `scanners.ts` are pure functions of the source and an index. Each returns the token and the next index, and throws with the offset of the character at fault.
- `digits` refuses a leading, a trailing or a doubled `_`. So a later strip of every `_` from a number lexeme is safe.
- `scanNumber` keeps the `0x` prefix and assigns no meaning. The parser decides whether 24 hex digits make an ObjectId, because that is a syntax question that productions.ts owns.
- A `.` after the integer digits always belongs to the number, as in JavaScript. `1.e3` is 1000, and a member access on an integer needs a second dot (`1..toString()`). A read of the dot as an access gives `1.e3` the wrong meaning.
- `decodeEscape` is the single decoder for every quoted form: a string, a template and the escape forms `\xHH`, `\uHHHH`, `\u{H…}`. Any other escaped character stands for itself. Two decoders drift apart, and then one form reads an escape in a different way from the other.

## Consequences

A new token is a new row, not a branch in the lexer. A new two-typed row must state `chooseBy` or the module fails to load. A new quoted form must call `decodeEscape`. docs/specs/grammar.md § Numeric separators and its note on decimal numbers must agree with the `.` rule above.
