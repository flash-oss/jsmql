# 0082. Filter and value forms of the string method rows

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

A string method in a filter should give a query form that an index can use. PCRE and JavaScript regex differ, and HR5 reads a missing string as `""`.

## Decision

- `.startsWith`, `.endsWith` and `.includes` in a filter give a regex query. An anchored regex can use an index, and a regex does not abort on a non-string value, unlike `$indexOfCP`. The needle must be a literal, because a run-time needle cannot go into a pattern.
- `.endsWith` anchors with `\z`, the end of the subject. PCRE `$` also matches before a final newline. MEASURED: `/\.pdf$/` selects both "report.pdf" and "report.pdf\n"; `\.pdf\z` selects only "report.pdf", as JavaScript `endsWith` does.
- A dot reads a missing string as `""`. `""` starts with, ends with and includes the empty needle, so an empty needle also matches a missing field (`orMissing`). The same rule applies to `.match()` with a regex that matches `""` (`matchesEmpty`).
- `.match()` in a filter with a regex literal gives a live RegExp that the driver sends as a BSON regex, which an index reads. A string pattern or a computed regex keeps the expression fallback. The clause is `{ s: { $regex: /re/ } }`, not `{ s: /re/ }`. MEASURED: both select the same documents at every query site that JSMQL emits into. The operator form survives in two positions that JSMQL emits into: a sibling operator on the same field (`{ s: { $regex: /^a/, $ne: "zzz" } }`) and `$elemMatch`, which needs an object. An element of `$in` takes the bare form, because the server refuses an operator document there; `queryOrMissing` in src/registry/vocabulary.ts writes it. `literal` builds the regex with MongoDB options (src/bson.ts). So a JavaScript `g` does not reach the wire as dotAll, and the builder keeps a dotAll `s`.
- `.split("")`: MEASURED, the server refuses `{ $split: ["$s", ""] }`, and MongoDB has no operator that splits into characters. So the row refuses the empty separator.
- `.indexOf` on a string: MEASURED, `$indexOfCP` refuses a negative start. JavaScript reads a negative position as 0, the default. So a constant negative start drops, and a run-time start takes `$max`.
- `.lastIndexOf` on a string: `$indexOfCP` searches forward only, so the row has no string form, and its `sibling` hint names the forward search method.

## Consequences

A new string filter form must handle the empty needle and stay a literal-only regex. Use `\z`, never `$`, for an end anchor.
