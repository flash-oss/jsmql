# 0059. What makes a word a keyword, and the one-way edge to productions

Status: Accepted
Applies to: `src/registry/ast.ts`, `src/registry/keywords.ts`

## Context

src/registry/keywords.ts is the registry of reserved words for the lexical phase. JavaScript allows a reserved word as a property name, and a MongoDB field can have any name.

## Decision

A word has a row only if the lexer promotes it to its own token type. A word that stays an identifier has no row. `function` is not reserved: the lexer reads it as an identifier and the parser recognises it, so it lives in productions.ts. Thus `FuncDecl` has two forms, `arrow` and `function`. The file holds no MQL. The meaning of a keyword is the production it heads.
Every reserved word is also a legal name after `.` and before `:` in an object literal. So `$.delete`, `{ null: 1 }` and `$in(…)` compile. The lexer reads the word as an `Ident` after an introducer (`introducesName` in tokens.ts), and the parser accepts any keyword token where a key goes. The exception is the shorthand `{ in }`, which JavaScript refuses. Only `undefined` is an identifier there.
keywords.ts does not import productions.ts. A keyword that points at its rules, and rules that point back at the keyword, make a type cycle that TypeScript refuses. It would also state one fact in two files. The edge goes one way: a production lists its `tokens`.

## Consequences

To find which production a keyword heads, search productions.ts. Do not add a back-reference from keywords.ts.
