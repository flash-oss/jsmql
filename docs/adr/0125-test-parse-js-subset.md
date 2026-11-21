# 0125. The JavaScript syntax rules that compiler-parse.test.ts holds the parser to

Status: Accepted
Applies to: `test/compiler-parse.test.ts`

## Context

Every JSMQL program must be valid JavaScript syntax, and the parser must refuse each form that JavaScript refuses. `test/compiler-parse.test.ts` asks `node:vm` for JavaScript's own answer, and asserts the parser's answer.

## Decision

- The harvest reads the sources of every suite in `test/`. A regex that stops matching reads nothing, so the test asserts a floor on the number of harvested sources.
- The fold inlines a constant. So only the parser can see two declarations of one `const` or `let` name, and the parser refuses them.
- JavaScript binds a postfix `++` tighter than every prefix and binary operator, so `1 + $.x++` is `1 + ($.x++)`. Each such source is valid JavaScript, but the write sits inside a value. A write stands only as a statement, so JSMQL refuses it. An assignment operator follows the same rule, and so does `delete`.
- A write in an array reads as a pipeline element to the parser. The position pass puts the array in a value, and the desugar pass gives the same refusal.
- The parser builds a `BinaryExpr`, `UnaryExpr` or `AssignExpr` from the text of the token. No table maps a token type back to a spelling. So every operator lexeme that such a row consumes must be in the operator set of the AST, and the reverse also holds. The check runs on runtime data, because a type-level check is vacuous. A const generic does not carry `becomes`, so a conditional sees `NodeName` and matches nothing. The check counts an operator-role token anywhere in the row, and a keyword only as the trigger of the row (`in`, `typeof`). `foreignJoin` also consumes `const` and `let` before its `=`, and neither is the operator that it builds.
- ECMAScript allows any IdentifierName after `.` and before `:`, and a MongoDB field can have any name. The test loops over `KEYWORDS`, so a new keyword gets coverage when its row exists.
- `({ in })` is a SyntaxError. Only `undefined` is an identifier reference, so only `undefined` is a legal shorthand property.
- One statement loop reads an entry block and the top level. So a trailing `;` means "pipeline" in both places.
- `a?.b.c = 1` is a SyntaxError, as `a?.b = 1` is. The parser keeps the optional-chain flag on the chain through every later link.
- The parser refuses a compound operator on `$` and `$$`. Without this refusal, `$ += 1` becomes a `$ = $ + 1` that looks valid. The value form gets the same refusal.

## Consequences

Before you accept a new construct, run `node --check` on it. Add each new refusal with its legal neighbour, so the test proves both sides.
