# 0146. A spread of a string into its characters

Status: Rejected
Applies to: the array and object spread lowering, the `returns` of the rows in `src/registry/names.ts`

## Context

JavaScript spreads a string into one element per character. `[..."abc"]` is `["a","b","c"]`, and `{ ..."ab" }` is `{ 0: "a", 1: "b" }`. The idea: accept this spread in JSMQL.

## Decision

JSMQL does not accept it. MongoDB has no operator that does this. `$concatArrays` takes only arrays, and `$mergeObjects` takes only documents, so nothing exists to lower the spread to.

An unchanged string in the output is worse than a refusal. `[..."abc"]` would silently answer the bare string `"abc"`, with no error at compile time or at run time. Where a sibling element follows, the server refuses the emitted `{ "$concatArrays": ["abc", ["d"]] }` instead. That is the same wrong shape, found later.

## Consequences

- The compiler refuses the spread wherever the operand is provably a string: a string literal, or an expression whose row measures a string return.
- A field path proves nothing, so `[...$.s]` still compiles. The compiler cannot know the type there, so the server answers.
- The refusal names the spelling that gives the characters: `<string>.length().range().map(i => <string>.charAt(i))`. It reads one code point at a time, so it agrees with JavaScript on a multi-byte character.
- Reconsider only if MongoDB gets a string-to-array operator.
