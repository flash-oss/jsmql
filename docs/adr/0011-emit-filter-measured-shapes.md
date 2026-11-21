# 0011. The filter road anchors with \z and writes the $regex operator form

Status: Accepted
Applies to: `src/compiler/emit/filter.ts`, `test/compiler-filter.test.ts`

## Context

The query language reads a regex differently from JavaScript and from the expression language. Give the number, or write: Some shapes run on the server and answer a different question.

## Decision

- **`.endsWith` anchors with `\z`.** `\z` is the end of the SUBJECT. PCRE's `$` also matches before a final newline, so `$` accepts `"z.\n"` where JavaScript's `endsWith("z.")` does not.
- **A regex test writes the operator form `{ s: { $regex: /^a/i } }`, not `{ s: /^a/i }`.** MEASURED: the two select the same documents at every query site. Two sites need the operator form, and jsmql emits into both: a sibling operator on the same field (`{ s: { $regex: …, $ne: "zzz" } }`), and `$elemMatch`, which needs an object.
- **A PCRE anchor matches on the empty string.** `/\A\z/` matches `""` on the server, so the cell adds the null test beside it (`{ $in: [/\A\z/, null] }`). JavaScript reads `\A` as the letter `A`, so the cell cannot ask JavaScript whether the pattern matches `""`.

The refusal of a computed value in a raw query document is in [ADR 0013](0013-emit-filter-raw-query-document.md).

## Consequences

A new query cell that writes a regex keeps the operator form and the `\z` anchor.
