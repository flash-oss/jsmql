# 0151. lodash array methods with no clean MQL form

Status: Rejected
Applies to: the array value-method rows in `src/registry/names.ts`, `didYouMean` in `src/levenshtein.ts`

## Context

Value mode covers the lodash array vocabulary that maps cleanly to MQL. The idea: also accept the lodash array methods below.

## Decision

The developer rejected these methods, each for its own reason:

- **Mutators**: `pull`, `pullAll`, `pullAllBy`, `pullAllWith`, `pullAt`, `remove`. JSMQL values are immutable expressions, so no array exists to change in place.
- **Custom-comparator `*With`**: `differenceWith`, `intersectionWith`, `unionWith`, `uniqWith`, `xorWith`. An arbitrary `(a, b) => bool` comparator has no MQL equivalent, because MongoDB compares by value or by key, not by a user callback.
- **Deep or recursive**: `flattenDeep`, `flattenDepth`, `flatMapDeep`, `flatMapDepth`, `zipObjectDeep`. A single aggregation expression cannot express recursion of unbounded depth, and an unroll to a fixed depth gives poor DX. A property-path key (`zipObjectDeep`) is a pitfall that MQL cannot honour.
- **Binary-search sorted index**: `sortedIndex`, `sortedIndexBy`, `sortedIndexOf`, `sortedLastIndex`, `sortedLastIndexBy`, `sortedLastIndexOf`. MQL has no binary-search primitive. `$indexOfArray` already scans linearly and is the lowering of `.indexOf`, so a "sorted" fast path gives no gain.
- **No MQL meaning**: `forEachRight` and `invokeMap`. Iteration for a side effect has no value in a pure expression. `invokeMap` calls a method by path for each element, but MQL has no runtime method dispatch.
- **`unzipWith`**: its iteratee gets a group whose arity equals the row count of the receiver. The compiler knows that value only at run time, and an arrow with fixed parameters cannot express it.

## Consequences

- Each method gets the standard unknown-method error. `didYouMean` gives a suggestion when a supported name is close, so none of these needs a rejection site or a `[DEF-NNN]` tag.
- `unzipWith` has a tailored error. It points at the idiomatic form, `.unzip().map(group => …)`.
- Instead of a mutator, write `.without(...)`, `.reject(pred)` or `.difference(other)`.
- Instead of a `*With` method, write the `*By` variant (`differenceBy`, `uniqBy`, and others). It compares by a derived key.
- Instead of a deep method, write `.flatten()` for one level.
- Reconsider a method only if MongoDB adds the primitive that it needs.
