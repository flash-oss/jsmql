# 0049. The parser refuses what JavaScript refuses, where it sits, with a message that names the fix

Status: Accepted
Applies to: `src/compiler/parse/parser.ts`

## Context

JSMQL is a strict subset of JavaScript. A construct that JavaScript refuses must also fail in JSMQL. A refusal must also point at the construct, and name the spelling that works. Some JavaScript forms parse but have no MQL meaning. Some refusals depend on a later phase.

## Decision

JavaScript rules that the parser mirrors (`src/compiler/parse/parser.ts`):
- `refuseDuplicateParams`: JavaScript refuses one name twice in an arrow's parameter list, and in every list that holds a destructuring pattern. It allows the name twice only in a plain `function (x, x)` list, and so does the parser.
- `declare` holds JavaScript's rule of one declaration per scope (docs/specs/grammar.md, the `let_decl` note). A function's parameters and the declarations at the top of its block share one scope. The parser holds this rule, not a later phase, because the fold inlines a constant declaration before a later phase can see it.
- No separator is needed after `function f(x) { … }`, because the declaration ends with its closing brace, as in JavaScript.
- A reserved word is a legal object key but not a legal shorthand. `({ in })` and `({ null })` are SyntaxErrors. Only `undefined` is an identifier there.
- `delete a?.b` is legal JavaScript, unlike `a?.b = 1`. So `delete` checks only that its operand is a place.
- Once a `?.` appears, the whole chain is an optional chain in JavaScript. `postfix` keeps the `optionalMemberAccess` rule through every later link, so `a?.b.c = 1` is refused as `a?.b = 1` is.

Parameters:
- `param` reads a pattern with a default, a rest element, a nested pattern or a computed key as `refused`, with the error to throw. The caller throws it only when an arrow follows. Without an arrow, `([...a, b])` is a legal expression and `(x = 1)` is a write in parentheses, so the parser rewinds.

Forms with no MQL meaning:
- `function*` is a generator. MQL has no way to suspend an expression. `refuseGenerator` refuses the star where it sits, not as a stray token later.
- `async function` has nothing to await in MQL. `refuseAsync` refuses the word where it sits.
- `refuseWholeTarget`: an arithmetic write needs a field. `$` is the whole document and `$$` is the root stream, so `$ += 1` and `$$++` are refused. A `=` replaces either one. A collection (`$$$.<coll> += …`) takes the write as a `$merge`. Both stay legal.
- The parser refuses a hex integer that a double cannot hold exactly (docs/specs/grammar.md, `hex_number`). Such a run loses precision with no warning, so the refusal names the spellings that work.

Message choices:
- A refusal of a write to a method result names the call that the source wrote (`.trim()`), not the `.field` rule that built its receiver.
- The parser exports `writeInValueOf` for the desugar pass. The desugar pass asks the parser for the refusal, so the wording is the one that the parser gives `$.y = $.x++`. docs/specs/desugar-pass.md § The driver states when that walk runs.

## Consequences

A new refusal must name the position and a spelling that works, in the wording of its siblings. A new JavaScript form must parse in JSMQL only when `node --check` accepts it. A change to the scope rule must stay in the parser while the fold inlines constants before later phases.
