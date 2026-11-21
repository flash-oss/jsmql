# 0092. The division of the registries and the core dispatch axes

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

`src/registry/` holds the single source of truth. Its files divide by compiler phase, and `vocabulary.ts` holds the shared types.

## Decision

- Each registry has one key space and one job. `tokens.ts` (lexical, what the lexer emits, keyed by the spelling or a class name). `keywords.ts` (lexical, the identifiers the lexer reserves, keyed by the word). `productions.ts` (syntactic, how tokens combine, descriptive keys). `names.ts` (semantic, everything resolved by name, keyed by the typed name).
- Two rules hold the division, and the type system tests each one inside the file that refers. `tokens.ts` and `keywords.ts` hold NO MQL, because the lexer is their only reader and cannot use a renderer. Every name that one registry mentions must be a key of the registry it points at.
- `NodeName` derives from `./ast.ts`, which imports nothing. A hand-written list drifts: it can name nodes that the name-blind tree does not have, and nothing tests it.
- `GROUP_SLOT` (`__jsmqlTmp`) is the one flat scratch field that a `$group` can write. The output key of an accumulator cannot hold a dot, so scratch inside a group cannot live under the `__jsmql` object. The next stage consumes it. It is the twin of `GROUP_TMP` in `src/namespace.ts`, because the registry imports nothing outside itself. `test/registry-agrees.test.ts` holds the two equal.
- `Family`: what can carry a name. The value types, `stream` (`$$`), and the namespace receivers. The parser folds `Math.round(x)` into one node whose name is `round` and whose receiver is `Math`, the same shape as `$.n.round()`. `cluster` is a family, because the diagnostic source stages divide by scope, and the wrong prefix is an error: `$$.indexStats()` runs and `$$$$.indexStats()` is refused; `$$$$.currentOp()` runs and `$$.currentOp()` is refused.
- `FIELD_FAMILY_TYPES` is the one table of the families that a document field can have, each with its `$type` names. A bare namespace name and `cluster` are never a field, and `stream` is `$$`. So a receiver of unproven family is one of these families.
- `Context`: one lexeme can form different constructs. A `{` opens an object literal in an expression and a parameter binding in a params slot, so a `forms` row names its context.
- `ArgShape` and `ByArgs`: the shape of the arguments is a third dispatch axis, beside `where` and `on`. `ObjectId()` mints a value, `ObjectId("<hex>")` is a live BSON value, and `ObjectId($.id)` is `$toObjectId`. The classes are a PARTITION, decided in this order: `none`; `multiple` (more than one argument of any type: a count, not a type, so `new Date($.ms)` is `$toDate` and `new Date($.y, $.m, $.d)` is `$dateFromParts`); `object` (one object literal); `constant` (one argument that the fold can evaluate); `dynamic` (one that it cannot). A key holds each answer, and `otherwise` states the rest, so what stays is a decision and not a hole. A `constant` that REACHES a row is one that the fold did not settle. It can be a value with no source spelling (a Date, an ObjectId). It can be a value that the server refuses (`ObjectId("nothex")`, which becomes a refusal in the developer's terms). It can also be a value whose type the server decides.
- `FamilyMap` is an interface, so the recursion of `TypeExpr` resolves.

## Consequences

A new registry file, family or argument class must keep one key space per file and one answer per class.
