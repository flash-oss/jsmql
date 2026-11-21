# 0053. The parser refuses what JavaScript refuses, where it sits, with a message that names the fix

Status: Accepted
Applies to: `src/compiler/parse/parser.ts`

## Context

JSMQL is a strict subset of JavaScript. A construct that JavaScript refuses must also fail in JSMQL. A refusal must also point at the construct, and name the spelling that works. Some JavaScript forms parse but have no MQL meaning. Some refusals depend on a later phase.

## Decision

JavaScript rules that the parser mirrors (`src/compiler/parse/parser.ts`):
- `refuseDuplicateParams`: JavaScript refuses one name twice in an arrow's parameter list, and in every list that holds a destructuring pattern. It allows the name twice only in a plain `function (x, x)` list, and so does the parser.
- `declare`: a function's parameters and the declarations at the top of its block share one scope. So `x => { const x = 1; … }` and a second `let a` in one block are refused. A nested function opens its own scope, and a declaration there may shadow an outer name. The parser holds this rule because the fold inlines a constant declaration before a later phase can see it.
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
- A `0x` lexeme with exactly 24 hex digits is an ObjectId. Any other hex run is an integer only when a double holds it exactly. A longer run loses precision with no warning. The parser refuses it and names the spellings that work.

Message choices:
- A refusal of a write to a method result names the call that the source wrote (`.trim()`), not the `.field` rule that built its receiver.
- `writeInValueOf` is exported for the desugar pass. Only the position pass knows that the array in `$.y = [$.x++]` is a value. So the desugar pass asks the parser for the refusal before any rule rewrites the write, and the message quotes the source form.

## Consequences

A new refusal must name the position and a spelling that works, in the wording of its siblings. A new JavaScript form must parse in JSMQL only when `node --check` accepts it. A change to the scope rule must stay in the parser while the fold inlines constants before later phases.
