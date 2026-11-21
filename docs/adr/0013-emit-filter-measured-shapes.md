# 0013. The filter road refuses a computed query value, anchors with \z, and writes the $regex operator form

Status: Accepted
Applies to: `test/compiler-filter.test.ts`

## Context

The query language reads a value slot and a regex differently from JavaScript and from the expression language. Several shapes run on the server and answer a different question.

## Decision

- **A computed expression in a raw query value slot is refused.** `{ a: $.b > 1 }` would become `{ a: { $gt: ["$b", 1] } }`. That is neither a value nor a query operator. The server accepts it and matches nothing. So `lowerFilter` refuses it.
- **`.endsWith` anchors with `\z`.** `\z` is the end of the SUBJECT. PCRE's `$` also matches before a final newline, so `$` accepts `"z.\n"` where JavaScript's `endsWith("z.")` does not.
- **A regex test writes the operator form `{ s: { $regex: /^a/i } }`, not `{ s: /^a/i }`.** MEASURED: the two select the same documents at every query site. Two sites need the operator form, and jsmql emits into both: a sibling operator on the same field (`{ s: { $regex: …, $ne: "zzz" } }`), and `$elemMatch`, which needs an object.
- **A PCRE anchor matches on the empty string.** `/\A\z/` matches `""` on the server, so the cell adds the null test beside it (`{ $in: [/\A\z/, null] }`). JavaScript reads `\A` as the letter `A`, so the cell cannot ask JavaScript whether the pattern matches `""`.

## Consequences

A new query cell that writes a regex keeps the operator form and the `\z` anchor. A raw query document with a computed value stays a refusal.
