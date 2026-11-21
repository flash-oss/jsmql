# 0082. The lexer facts that the token rows state

Status: Accepted
Applies to: `src/registry/tokens.ts`

## Context

`src/registry/tokens.ts` describes what the lexer emits. Some lexer decisions depend on position or on the preceding token, and a plain longest-match table cannot state them.

## Decision

- `token` holds a LIST when the lexer picks the token type by position. A backtick is `TemplateStart` at the start and `TemplateEnd` at the end.
- `maxRun`: a cap on the repeats of one spelling. A longest-match table reads `$$$$$` as `$$$$` and `$`, two valid tokens. The lexer instead refuses the longer run, and `tooLong` is its message.
- `chooseBy`: a `/` is division after a value and a regex in all other places. The PRECEDING token decides. `ENDS_A_VALUE` lists the token types that end a value. It is one declaration and not a flag per row, because the backtick row covers two token types and only `TemplateEnd` ends a value. Examples: `$.a / 2` is `Slash`; `/ab/.test` is `RegexLiteral`; `$.typeof / 2` is `Slash`, because `typeof` after `$.` is an `Ident`. The list holds no keyword token. A reserved word as an operator never ends a value. A reserved word in the role of a name is already an `Ident`.
- `introducesName`: the lexeme AFTER the introducer is a name, even when it spells a reserved word. `$.typeof`, `x.delete`, `$in(…)` and `a?.null` are legal JavaScript, and a MongoDB field can have any name. The introducer holds the cell, because the introducer changes how the lexer reads the next lexeme. The same word one token later is the operator again (`$.typeof in xs`).
- `{` has `tracksDepth`, so a template interpolation can tell its OWN closing brace from the brace of a nested object. In `${ {a: 1} }` only the outer brace ends the interpolation.
- `}` has `resumesTemplateAtDepth`: when its depth agrees with an open interpolation, it emits NO token, ends the interpolation, and template text continues. It is the one closer that makes nothing.

## Consequences

A new context-dependent lexeme states its rule on its row. The lexer reads the row and holds no special case.
