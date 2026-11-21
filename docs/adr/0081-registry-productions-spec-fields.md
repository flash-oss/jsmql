# 0081. The non-obvious fields of a production row

Status: Accepted
Applies to: `src/registry/productions.ts`

## Context

`ProductionSpec` in `src/registry/productions.ts` describes one grammar rule. The parser and the emitter read its fields, so each field must state one exact rule.

## Decision

- `tokens`: the symbols that the rule consumes. The FIRST entry is the trigger, and the parser builds its dispatch tables from `tokens[0]`. The order of the rest is free. `conditional` leads with `?`, and `methodCall` leads with `.`.
- `spelling`: how a developer WRITES the rule, and the text by which every refusal names it. The descriptive key (`conditional`, `remainder`) must never reach a user. A join of `tokens` cannot give it either, because `tokens` lists every lexeme.
- `associativity: "none"`: the operator cannot chain, and `1 === 2 === 3` is a parse error.
- `passesNull`: MEASURED, `{ $add: ["$nope", 1] }` and `{ $add: [null, 1] }` are both null. The rule, and the reason that a comparison does not state the fact, are in [types.md § Presence](../specs/types.md#presence).
- `after`: the rules that the parser must try BEFORE this one when two triggers overlap. An audit tests the names.
- `word`: the literal identifier text that a rule needs when its trigger is the `identifier` class. `function` is NOT a reserved word, so `keywords.ts` has no row for it. The parser still recognises it for `function f(x) { return x }`. The word sits on the rule, so no phase holds a hard-coded name.
- `noMixWith`: levels that cannot sit beside this one, on EITHER side, without parentheses, because JavaScript refuses the pair. `a ?? b || c` and `a || b ?? c` are both SyntaxErrors.
- `leftOperandNot`: levels that the LEFT operand cannot be without parentheses. JavaScript states this rule one-sided for `**`. `-a ** 2` and `typeof a ** 2` are SyntaxErrors, and `2 ** -1` and `2 ** typeof a` parse (`node --check`). A symmetric rule would refuse valid JavaScript.
- `flattensChain`: a left-nested chain lowers as ONE operator: `a * b * c` gives `{ $multiply: [a, b, c] }`. Associativity alone does not say this, because `a - b - c` is two subtractions.
- `neverAWriteTarget`: the node can never be the target of `=`, `+=`, `++` or `--`. `a?.b = 1` is a SyntaxError for an optional chain anywhere in the target. The message names the row's `spelling` and ends with the `instead` text. `delete a?.b` is legal, so the rule does not cover `delete`.
- `asStatement`: the rule builds a write that JavaScript also reads as a value (`$.y = $.x++`). A write stands only as a statement, so the parser refuses the value reading. The refusal names the compound write to use (`$.x += 1;`). A postfix spelling places that statement after the read, and a prefix spelling places it before.
- A filter cell of a comparison answers null when the operands are not a field path and a constant. That null is the stated signal to wrap the value form in `$expr` (see `FilterOut`). The `filter` cell of a comparison states the kinds of its `expr` cell, so both forms refuse the same operands. A query reads an array field through its elements (see `proofsFor`).
- Name-blind nodes: `Date.UTC(y, m)` is a `MethodCall` on the name `Date`, and `Math.PI` is a `MemberAccess`. Every namespace shares these two node types, and the parser does not need to know the namespace. Every `new X(…)` is one `NewExpression` node, so a refusal can name the callee. A bare name that the developer does not apply stays an `Ident`, and the `asReference` field on its row says if a reference is legal. A parameter name and a bare name look the same at parse time; scope decides, and the injection pass puts the supplied value in its place.
- Bracket access (`o[k]`): a key of any kind reads as its string, as JavaScript reads `o[k]`. A null key reads no field.

## Consequences

A new production states each of these facts on its row. No phase infers them.
