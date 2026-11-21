# 0018. Rules for correlation paths and chain routing in the join road

Status: Accepted
Applies to: `test/integration.test.ts`, `test/lookup.test.ts`

## Context

The join road (`src/compiler/emit/join.ts`) lowers a `$$$.<coll>` chain to a `$lookup`. The server refuses some shapes that look valid, and it accepts other shapes that give wrong data. The rules below keep the emitted `$lookup` valid and correct.

## Decision

- The bare root `$` is a field reference with an empty path, and it adds no path segment. So `$["ext-code"]` gives the `localField` `ext-code` and the `let` value `$ext-code`. A leading dot (`.ext-code`) makes the server reject the pipeline.
- The `let` variable name comes from the sanitized segment (`jsmql_f0_ext_code`), and the value keeps the raw path. The allocator interns on the RAW path. When two raw paths sanitize to one base (`sub-id` and `sub_id`), the second name gets the suffix `_2`, so each field keeps its own variable.
- The bare `$` is the whole outer document, not a path, so it cannot be a `localField`. It goes into `let` as `$$ROOT`. The same holds for an outer foreign parameter that a nested body reads with no segment.
- A bare foreign parameter (`o => o`) is a document. A document is always present and always truthy, so its truthiness test folds to `true`.
- A `.map` to an object literal keeps each element a document, so `$replaceWith` in the `$lookup.pipeline` is valid. A later link such as `.take` lowers to `$limit` in the same pipeline.
- A `.map` to a scalar cannot be a `$replaceWith`, because the server rejects a root that is not a document. When a stream link follows such a map, the whole chain takes the value road. The sub-pipeline holds the earlier links. The map and the later links run as array operators over the slot.
- A return-only block (`o => { return o.total; }`) on a stream means the same as the expression body. It lowers to the value `$map`, never to a scalar `$replaceWith`.
- A comparator sort (`.toSorted((a, b) => …)`) has no value lowering, because `$sortArray` has no comparator form. So the compiler keeps it in the pipeline as a `$sort` stage.
- A `$$$.<coll>` read with no destination gets one refusal for every chain head. The message names the head, not the methods that can follow it, because that set changes.
- `.aggregate` on a receiver that a chain already reduced to a value gets a tailored refusal that says what the receiver became. The generic value path would refuse it as an unknown method and give no way forward.

## Consequences

A change to path capture or to `let` naming must keep the empty-path rule, the raw-path interning and the `$$ROOT` rule. A change to chain routing must keep scalar maps out of `$replaceWith`. Check each changed shape on the project's mongod.
