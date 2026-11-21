# 0050. One row-driven Pratt loop, a name-blind parser, and one shared reader for each repeated question

Status: Accepted
Applies to: `src/compiler/parse/cursor.ts`, `src/compiler/parse/parser.ts`, `src/compiler/parse/tables.ts`

## Context

`src/compiler/parse/parser.ts` reads src/registry/productions.ts through the tables in `src/compiler/parse/tables.ts`. A new operator must be a new row, not a new method. JavaScript also has rules that a precedence number cannot express. Several questions arise at more than one place in the parser, and copies of one question drift apart.

## Decision

The loop and its tables:
- One Pratt loop reads `precedence`, `associativity` and `fixity` from the rows. A level is a number on a row, not the depth of a call chain. A rule's trigger is `tokens[0]`.
- The tables hold one entry per trigger, not per rule. A lexeme can head more than one rule, and lookahead picks one: `.` heads `memberAccess`, `methodCall` and `namespacedCall`, and only a following `(` decides. All rules of one trigger must agree on the level and the associativity. `build` in tables.ts checks this at load time, because no lookahead can fix a disagreement.
- A precedence of 0 means that the row declares no level, so it never binds inside an expression.
- `noMixWith` and `leftOperandNot` state the mixing rules that a number cannot state. `a ?? b || c` is a JavaScript SyntaxError on either side. `-a ** 2` is one on the left only, and `2 ** -1` is valid. `mixingRefused` reads both lists.
- A parenthesised group drops the rule that produced its inner node. Parentheses are what make a refused mix legal.
- `tail` reports the rule that distinguishes a postfix step (`optionalMemberAccess` for `?.`). So a write can ask whether its target may be that rule.
- `MAX_DEPTH` stops the parser before the call stack does. Such depth marks a hostile input, not a query.

The parser is NAME-BLIND:
- It never compares an identifier to a set. `Math`, `String` and a lambda parameter are all `Ident`, and names.ts decides later. The one name fact that the parser reads is `blockBodyOf`, because only the parser holds a callee and its `{ … }` body at the same time.
- `dollar()` does not record how the arguments of `$name(…)` were written. The operator's row states its shape. One object argument is a body only by that shape, never by a guess in the parser.
- `function` is not a reserved word in the lexer. So `WORDS` matches the text from the row's `word` field, and the parser holds no copy of the word.
- Every keyword is valid where a name stands (`identLike`, `Cursor.isNameLike`), because JavaScript allows any IdentifierName after `.` and before `:` in an object literal. `{ null: 1 }` and `$let({ in: … })` are names. The lexer already turns a word after an introducer into `Ident`. `isNameLike` catches the rest, mostly an object key.

The cursor (`cursor.ts`):
- The `type` getter is for a table lookup only. A comparison uses `is(type)`. TypeScript narrows a getter and keeps the narrowing across a `next()` call, so a second comparison of `type` fails to type-check.

One reader for each repeated question:
- `dollarName` joins `$` and the next name into one `$name` token at each site that reads a `$`-named key or call. Separate copies used different rules about which names count. The lexer reads the word after `$` as a plain `Ident`, so no keyword case exists.
- `block` is the one statement loop for the top level, an entry block and a callback block. A new separator rule then reaches all three.
- `writeAhead` is the one predicate for "a write starts here". A `;` statement, an array element and the token after a `,` inside brackets all ask it. Separate copies missed the parenthesised spelling in one site.
- `STATEMENT_PREFIX` is the one list of tokens that open a write (for example `delete`). It comes from the rows whose only position is `statement` and whose trigger is a prefix.
- `ASSIGN_TRIGGERS` holds only the operator tokens of the rows that build an `AssignExpr`. Those rows also consume `$.`, `(` and `=>`, and a `(` after an expression is a call, not a write.
- `requireWriteTarget` reads `NEVER_A_WRITE_TARGET`, which comes from the `neverAWriteTarget` row field. So the `optionalMemberAccess` row enforces its own rule, and no branch tests `.optional`.

Writes:
- A write is a question about the lexemes ahead, not about meaning. `startsAWrite` is a token scan to the end of the expression (the first `,`, `;` or closing bracket at depth zero). It looks for an assignment operator at depth zero. A speculative parse doubles the work at each nesting level, which is exponential on `[[[…]]]`, and it swallows the errors that the speculation raises.
- `writeGroup` exists because inside parentheses a `,` always continues the group. A formatter writes `($.a = 1, $.b = 2)`. Outside parentheses the `,` means different things to the two callers.
- In the `;` form a `,` continues the run until the `;`. In the bracketed form (`writeRun`) a `,` continues the run only when a write follows. A run of writes is one `$set` stage, and a value after the comma is the next element: `[$.a = 1, ++$.b]` gives one `$set` with `a` and `b`, and `[$.a = 1, $match(…)]` gives a `$set` and then a `$match`.
- A prefix write reads its operand at its own level, so `++$.a + 1` is `(++$.a) + 1`. A postfix write ends the target: `pratt(1, true)` sets `endsAtWrite`, and the loop stops at the postfix operator so the caller reads it. Everywhere else, a postfix write stands inside a value and is refused.
- `$.a = $.b = 1` gives every target the same value. So the chain becomes one write per target, not a nested assignment.
- The parser gives a write the position of its operator. `writeInValueOf` relies on this: a prefix operator stands before its target, and a postfix one after it.
- An element of an array that starts with `function` is a declaration, not a function value. Otherwise the lambda makes the literal look like an array of values, not a pipeline.

Entry form and statements:
- `function [name](…) { … }` is the second spelling of the entry arrow. The parser cannot reach the name, and drops it.
- A `return` in an entry block gives the expression itself, so a bare predicate stays a predicate, and the position phase reads it as a Filter.
- `collapse`: a lone statement stands on its own, so the shape phase can read it as a Filter. A lone declaration does not collapse, because nothing reads it. A statement that the source ends with `;` does not collapse, because that `;` says pipeline. This one rule holds for the top level and the entry block, so `({ $ }) => { X }` means exactly what `X` means.
- In a declaration list, the first declarator takes the position of the keyword, and each later one takes the position of its own name. So an error underlines the declarator that it is about.
- A destructured parameter becomes one fresh parameter. The fresh name differs from every name that the body mentions and from every other parameter, so no part can capture a name that the developer wrote.

## Consequences

A new operator, trigger or write spelling is a row change in productions.ts or tokens.ts, not a parser branch. A new place that asks a shared question must call the shared reader. A future change must keep the parser name-blind, except for `blockBodyOf`. A new rule that shares a trigger must declare the same level and associativity, or the module fails to load.
